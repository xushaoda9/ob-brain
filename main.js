'use strict';

const {
  FuzzySuggestModal, ItemView, Menu, Modal, Notice, Plugin,
  PluginSettingTab, Setting, TFile, TFolder, getLanguage, getAllTags, normalizePath, setIcon
} = require('obsidian');

const VIEW = 'ob-brain-graph';
const FIELD = 'ob-brain';
const SVG = 'http://www.w3.org/2000/svg';
const ZONE_LIMITS = {parent:12, child:32, jump:32, sibling:32};
const SIBLINGS_PER_COLUMN = 8;
const EXISTING_RELATION = ['这两个节点已存在关系，无法建立新连接。', 'These nodes already have a relationship.'];
const DUPLICATE_NODE_NAME = ['已存在同名节点，请使用其他名称。', 'A node with this name already exists. Choose a different name.'];
const DEFAULTS = {
  folder: 'OB Brain', renameFile: false, historyLimit: 10, rootSort: 'manual',
  searchScope: 'vault', searchAliases: false, language: 'auto'
};
const LABELS = {
  parent: ['父节点', 'Parents'], child: ['子节点', 'Children'],
  jump: ['跳转节点', 'Jumps'], sibling: ['同级节点', 'Siblings']
};

const collator = new Intl.Collator(undefined, { numeric: true });
const compareText = (a, b) => collator.compare(a, b);
const fold = value => String(value).toLocaleLowerCase();
const uniqueIds = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.trim()))] : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const limit = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
const clone = value => value === undefined ? undefined : structuredClone(value);
const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));
function generateId() {
  const crypto = globalThis.crypto;
  return 'n_' + (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
    Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2,'0')).join(''));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readNode(file, cache) {
  const fm = cache?.frontmatter;
  const source = fm?.[FIELD];
  if (!source || typeof source !== 'object' || !text(source.id)) return null;
  return {
    id: text(source.id), title: text(source.title) || text(fm.title) || file.basename,
    path: file.path, level: source.level === 'root' ? 'root' : 'node',
    children: uniqueIds(source.children), jumps: uniqueIds(source.jumps),
    description: text(source.description),
    tags: getAllTags(cache) ?? [],
    aliases: typeof fm.aliases === 'string' ? [fm.aliases.trim()].filter(Boolean) : uniqueIds(fm.aliases),
    order: Number.isFinite(source.order) ? source.order : 0,
    color: /^#[0-9a-f]{6}$/i.test(source.color) ? source.color : '',
    icon: text(source.icon) || 'file', mtime: file.stat.mtime, missing: false
  };
}

function addTo(map, id, value) {
  if (!map.has(id)) map.set(id, new Set());
  map.get(id).add(value);
}

class GraphIndex {
  constructor() {
    this.files = new Map();
    this.missing = new Map();
    this.nodes = new Map();
    this.parents = new Map();
    this.incomingJumps = new Map();
    this.dangling = [];
    this.duplicates = [];
  }

  rebuild() {
    this.nodes.clear();
    this.parents.clear();
    this.incomingJumps.clear();
    this.dangling = [];
    this.duplicates = [];
    for (const node of [...this.files.values()].sort((a, b) => compareText(a.path, b.path))) {
      const original = this.nodes.get(node.id);
      if (original) {
        this.duplicates.push([original.path, node.path]);
        continue;
      }
      this.nodes.set(node.id, node);
      this.missing.delete(node.id);
    }
    for (const node of this.missing.values()) this.nodes.set(node.id, node);
    for (const node of this.nodes.values()) {
      for (const [field, reverse] of [['children', this.parents], ['jumps', this.incomingJumps]]) {
        for (const id of node[field]) {
          if (id === node.id || !this.nodes.has(id)) {
            if (!node.missing) this.dangling.push({ from: node.id, to: id, field });
            continue;
          }
          addTo(reverse, id, node.id);
        }
      }
    }
  }

  hasDirectRelation(source, target) {
    const from = this.nodes.get(source);
    const to = this.nodes.get(target);
    return Boolean(from?.children.includes(target) || to?.children.includes(source) ||
      from?.jumps.includes(target) || to?.jumps.includes(source));
  }

  relatives(id) {
    const current = this.nodes.get(id);
    const fromIds = ids => [...new Set(ids)].filter(other => other !== id).map(other => this.nodes.get(other)).filter(Boolean);
    const parent = fromIds(this.parents.get(id) ?? []);
    const child = fromIds(current?.children ?? []);
    const jump = fromIds([...(current?.jumps ?? []), ...(this.incomingJumps.get(id) ?? [])]);
    const siblings = new Map();
    for (const source of parent) {
      if (source.missing) continue;
      for (const node of fromIds(source.children)) {
        if (node.missing || node.id === source.id) continue;
        if (!siblings.has(node.id)) siblings.set(node.id, { node, parents: [] });
        siblings.get(node.id).parents.push(source);
      }
    }
    return { parent, child, jump, sibling: [...siblings.values()] };
  }

  roots() {
    return [...this.nodes.values()].filter(node => node.level === 'root');
  }

  pathsToRoots(id) {
    const queue = [[id]];
    const seen = new Set([id]);
    const roots = new Map();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const path = queue[cursor];
      const head = path[0];
      if (this.nodes.get(head)?.level === 'root') roots.set(head, path);
      for (const parent of this.parents.get(head) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        queue.push([parent, ...path]);
      }
    }
    return roots;
  }

  search(query, { aliases = false, ids = null, recent = [] } = {}) {
    const term = fold(query.trim());
    if (!term) return [];
    const times = new Map(recent.map(item => [item.id, item.at]));
    const rank = label => label === term ? 0 : label.startsWith(term) ? 1 : label.includes(term) ? 2 : 3;
    return [...this.nodes.values()].filter(node => !ids || ids.has(node.id)).map(node => ({
      node, score: Math.min(rank(fold(node.title)), ...(aliases ? node.aliases.map(value => rank(fold(value))) : []))
    })).filter(item => item.score < 3).sort((a, b) => a.score - b.score ||
      (times.get(b.node.id) ?? 0) - (times.get(a.node.id) ?? 0) || compareText(a.node.title, b.node.title))
      .slice(0, 20).map(({ node }) => node);
  }

  neighborhood(id) {
    const ids = new Set(id ? [id] : []);
    let layer = [...ids];
    for (let depth = 0; depth < 2; depth++) {
      const next = [];
      for (const current of layer) {
        const { parent, child, jump, sibling } = this.relatives(current);
        for (const node of [...parent, ...child, ...jump, ...sibling.map(item => item.node)]) {
          if (ids.has(node.id)) continue;
          ids.add(node.id);
          next.push(node.id);
        }
      }
      layer = next;
    }
    return ids;
  }
}

class VaultGraph {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.index = new GraphIndex();
    this.pending = new Map();
    this.writes = Promise.resolve();
    this.timer = null;
    this.scanning = false;
    this.committing = false;
    this.disposed = false;
  }

  start() {
    const { vault, metadataCache } = this.app;
    this.plugin.registerEvent(metadataCache.on('changed', (file, _data, cache) => this.queue(file.path, { file, cache })));
    this.plugin.registerEvent(metadataCache.on('resolved', () => {
      if (!this.index.files.size) this.scan().catch(error => this.plugin.report(error));
    }));
    this.plugin.registerEvent(vault.on('create', file => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      const cache = metadataCache.getFileCache(file);
      if (cache) this.queue(file.path, { file, cache });
    }));
    this.plugin.registerEvent(vault.on('delete', file => {
      for (const path of this.pathsUnder(file.path)) this.queue(path, { deleted: true });
    }));
    this.plugin.registerEvent(vault.on('rename', (file, oldPath) => {
      for (const path of this.pathsUnder(oldPath)) {
        const next = file.path + path.slice(oldPath.length);
        const moved = this.file(next);
        const pending = this.pending.get(path);
        const node = pending?.node ?? (pending?.cache ? readNode(moved ?? pending.file, pending.cache) : this.index.files.get(path));
        this.pending.set(path, {});
        if (moved) this.queue(next, node ? { node: { ...node, path: next, mtime: moved.stat.mtime } } :
          { file: moved, cache: metadataCache.getFileCache(moved) });
      }
    }));
    this.app.workspace.onLayoutReady(() => {
      if (!this.disposed) this.scan().catch(error => this.plugin.report(error));
    });
  }

  pathsUnder(folder) {
    return [...new Set([...this.index.files.keys(), ...this.pending.keys()])].filter(path => path === folder || path.startsWith(folder + '/'));
  }

  file(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && file.extension === 'md' ? file : null;
  }

  queue(path, update) {
    if (this.disposed) return;
    this.pending.set(path, update);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this.scanning || this.committing || this.disposed || !this.pending.size) return;
    for (const [path, update] of this.pending) {
      const previous = this.index.files.get(path);
      if (update.deleted && previous) this.index.missing.set(previous.id, { ...previous, missing: true });
      const current = update.node ?? (update.file && this.file(path) ? readNode(update.file, update.cache) : null);
      if (current) this.index.files.set(path, { ...current, path });
      else this.index.files.delete(path);
    }
    this.pending.clear();
    this.changed();
  }

  changed() {
    this.index.rebuild();
    this.plugin.refreshViews();
  }

  scan() {
    if (this.disposed) return Promise.resolve();
    if (!this.scanTask) this.scanTask = this.enqueue(() => this.scanNow()).finally(() => { this.scanTask = null; });
    return this.scanTask;
  }

  async scanNow() {
    this.scanning = true;
    this.plugin.refreshViews();
    try {
      const files = this.app.vault.getMarkdownFiles();
      const next = new Map();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const node = readNode(file, this.app.metadataCache.getFileCache(file));
        if (node) next.set(file.path, node);
        if (i % 200 === 199) await yieldToUi();
        if (this.disposed) return;
      }
      for (const [path, node] of this.index.files) {
        if (!next.has(path) && !this.file(path)) this.index.missing.set(node.id, { ...node, missing: true });
      }
      this.index.files = next;
    } finally {
      this.scanning = false;
      if (!this.disposed) {
        if (this.pending.size) this.flush();
        else this.changed();
      }
    }
  }

  enqueue(task) {
    const run = this.writes.then(() => {
      if (this.disposed) throw new Error(this.plugin.t('插件已停用。', 'The plugin is disabled.'));
      this.flush();
      return task();
    });
    this.writes = run.catch(() => {});
    return run;
  }

  fail(zh, en) {
    throw new Error(this.plugin.t(zh, en));
  }

  requireFile(id) {
    const node = this.index.nodes.get(id);
    const file = node && !node.missing && this.file(node.path);
    if (!file) this.fail('找不到节点的笔记，请先重新绑定。', 'The node file is missing. Rebind the note first.');
    return file;
  }

  patch(id, action) {
    return { file: this.requireFile(id), apply: current => {
      if (current?.id !== id) this.fail('文件的节点标识已变更，请重建索引后重试。', 'The node ID changed. Rebuild the index and retry.');
      return action(current);
    }};
  }

  async alter(file, action) {
    let before, after, node;
    await this.app.fileManager.processFrontMatter(file, fm => {
      before = clone(fm[FIELD]);
      after = action(clone(before));
      if (after === undefined) delete fm[FIELD];
      else fm[FIELD] = after;
      node = readNode(file, { ...this.app.metadataCache.getFileCache(file), frontmatter: fm });
    });
    if (node) this.index.files.set(file.path, node);
    else this.index.files.delete(file.path);
    this.pending.delete(file.path);
    return { before, after };
  }

  async commit(changes, finish) {
    const completed = [];
    this.committing = true;
    try {
      for (const { file, apply } of changes) {
        completed.push({ file, ...await this.alter(file, apply) });
      }
      if (finish) await finish();
    } catch (error) {
      const rollbackErrors = [];
      for (const { file, before, after } of completed.reverse()) {
        try {
          await this.alter(file, current => {
            if (!same(current, after)) this.fail('文件已发生后续修改。', 'The file was modified again.');
            return before;
          });
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) {
        console.error('OB Brain rollback', rollbackErrors);
        this.fail('操作失败，部分更改无法回滚。请检查已修改笔记的属性。', 'The operation failed and some changes could not be rolled back. Check the affected note properties.');
      }
      throw error;
    } finally {
      this.committing = false;
      if (this.pending.size) this.flush();
      else this.changed();
    }
  }

  async ensureFolder(path) {
    let prefix = '';
    for (const part of path.split('/').filter(Boolean)) {
      if (part === '.' || part === '..') this.fail('请选择库内的文件夹。', 'Choose a folder inside the vault.');
      prefix = prefix ? prefix + '/' + part : part;
      const existing = this.app.vault.getAbstractFileByPath(prefix);
      if (!existing) {
        try { await this.app.vault.createFolder(prefix); }
        catch (error) {
          if (!(this.app.vault.getAbstractFileByPath(prefix) instanceof TFolder)) throw error;
        }
      } else if (!(existing instanceof TFolder)) this.fail('笔记目录与现有文件同名。', 'The note folder conflicts with an existing file.');
    }
  }

  filename(name) {
    const clean = name.replace(/[<>:"/\\|?*#^[\]\x00-\x1F]/g, '-').replace(/[. ]+$/, '').slice(0, 110);
    if (!clean) this.fail('请输入可作为文件名的节点名称。', 'Enter a name that can be used as a file name.');
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? '_' + clean : clean;
  }

  async createFile(name) {
    const setting = text(this.plugin.settings.folder).replaceAll('\\', '/');
    if (/^[a-z]:|^\/\/|(?:^|\/)\.\.(?:\/|$)/i.test(setting)) this.fail('请选择库内的相对目录。', 'Use a relative folder inside the vault.');
    const folder = normalizePath(setting);
    await this.ensureFolder(folder);
    const base = (folder && folder !== '/' ? folder + '/' : '') + this.filename(name);
    let path = base + '.md', suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = base + ' ' + (suffix++) + '.md';
    return this.app.vault.create(path, '');
  }

  order() {
    return Math.max(0, ...this.index.roots().map(node => node.order)) + 1;
  }

  async discardEmptyNote(file) {
    try {
      if (this.file(file.path) === file && await this.app.vault.read(file) === '') {
        await this.app.fileManager.trashFile(file);
      }
    } catch (error) {
      console.error('OB Brain note cleanup', error);
    }
  }

  hasNodeName(title) {
    const name = fold(title.trim());
    return [...this.index.nodes.values()].some(node => fold(node.title.trim()) === name);
  }

  create(options) {
    return this.enqueue(async () => {
      const { title, root, existing, source, relation, color, icon, description, rebind } = options;
      const name = title.trim();
      if (!name) this.fail('请输入节点名称。', 'Enter a node name.');
      if (!rebind && this.hasNodeName(name)) this.fail(...DUPLICATE_NODE_NAME);
      const previous = rebind && this.index.nodes.get(rebind);
      if (rebind && !previous?.missing) this.fail('该节点当前无需重新绑定。', 'This node no longer needs to be rebound.');
      const id = previous?.id ?? generateId();
      const changes = [];
      const metadata = {
        id, title: name, level: root ? 'root' : 'node', order: previous?.order ?? this.order(),
        color: color || '', icon: icon || 'file', description: description || '',
        children: [...(previous?.children ?? [])], jumps: [...(previous?.jumps ?? [])],
        created: new Date().toISOString()
      };
      if (source && relation === 'parent') {
        this.requireFile(source);
        metadata.children.push(source);
      }
      if (source && relation === 'jump') {
        this.requireFile(source);
        metadata.jumps.push(source);
      }
      if (source && relation === 'child') changes.push(this.patch(source, raw => ({ ...raw, children: [...new Set([...uniqueIds(raw.children), id])] })));
      const file = existing ? this.file(existing.path) : await this.createFile(name);
      if (!file) this.fail('所选笔记已不存在。', 'The selected note no longer exists.');
      changes.unshift({ file, apply: raw => {
        if (raw !== undefined) this.fail('该笔记已经包含节点属性。请选择另一篇笔记。', 'This note already has node properties. Select a different note.');
        return metadata;
      }});
      try {
        await this.commit(changes);
      } catch (error) {
        if (!existing) await this.discardEmptyNote(file);
        throw error;
      }
      return id;
    });
  }

  edit(node, values) {
    return this.enqueue(async () => {
      const title = values.title.trim();
      if (!title) this.fail('请输入节点名称。', 'Enter a node name.');
      const file = this.requireFile(node.id);
      const update = raw => ({
        ...raw, title, level: values.root === undefined ? raw.level : values.root ? 'root' : 'node',
        order: values.root && raw.level !== 'root' ? this.order() : raw.order
      });
      const target = values.existing ? this.file(values.existing.path) : values.newNote ? await this.createFile(title) : file;
      if (!target) this.fail('所选笔记已不存在。', 'The selected note no longer exists.');
      if (target.path !== file.path) {
        let metadata;
        try {
          await this.commit([
            this.patch(node.id, raw => { metadata = update(raw); return undefined; }),
            { file: target, apply: raw => {
              if (raw !== undefined) this.fail('该笔记已经包含节点属性。请选择另一篇笔记。', 'This note already has node properties. Select a different note.');
              return metadata;
            }}
          ]);
        } catch (error) {
          if (values.newNote && !values.existing) await this.discardEmptyNote(target);
          throw error;
        }
        return;
      }
      const nextPath = this.plugin.settings.renameFile ? file.path.slice(0, -file.name.length) + this.filename(title) + '.md' : file.path;
      const rename = node.title !== title && file.path !== nextPath;
      if (rename && this.app.vault.getAbstractFileByPath(nextPath)) this.fail('目标文件名已存在。', 'The target filename already exists.');
      const finish = rename ? async () => {
        const oldPath = file.path;
        await this.app.fileManager.renameFile(file, nextPath);
        const updated = this.index.files.get(oldPath);
        this.index.files.delete(oldPath);
        if (updated) this.index.files.set(file.path, { ...updated, path: file.path, mtime: file.stat.mtime });
      } : undefined;
      await this.commit([this.patch(node.id, update)], finish);
    });
  }

  pin(id, pinned) {
    return this.enqueue(() => this.commit([this.patch(id, raw => ({
      ...raw, level: pinned ? 'root' : 'node', order: pinned && raw.level !== 'root' ? this.order() : raw.order
    }))]));
  }

  reorder(id, beforeId) {
    return this.enqueue(async () => {
      const ordered = this.index.roots().filter(n => !n.missing).sort((a, b) => a.order - b.order || compareText(a.title, b.title));
      const from = ordered.findIndex(node => node.id === id), to = ordered.findIndex(node => node.id === beforeId);
      if (from < 0 || to < 0 || from === to) return;
      ordered.splice(to, 0, ...ordered.splice(from, 1));
      const changes = ordered.flatMap((node, order) => node.order === order ? [] : [this.patch(node.id, raw => ({ ...raw, order }))]);
      await this.commit(changes);
    });
  }

  edges(source, target, kind) {
    const [a, b] = kind === 'parent' ? [target, source] : [source, target];
    const field = kind === 'jump' ? 'jumps' : 'children';
    return { a, b, field };
  }

  link(source, target, kind, previous) {
    return this.enqueue(async () => {
      if (source === target) this.fail('节点不能连接到自己。', 'A node cannot link to itself.');
      this.requireFile(source);
      this.requireFile(target);
      const next = this.edges(source, target, kind);
      const before = previous ? this.edges(source, previous.target, previous.kind) : null;
      if (before && same(before, next)) return;
      if (previous?.target !== target && this.index.hasDirectRelation(source, target)) this.fail(...EXISTING_RELATION);
      const existing = this.index.nodes.get(next.a)[next.field].includes(next.b) ||
        (next.field === 'jumps' && this.index.nodes.get(next.b).jumps.includes(next.a));
      if (existing) this.fail('这两个节点已有相同关系。', 'These nodes already have this relationship.');
      const operations = new Map();
      const change = (id, field, targetId, add) => {
        const list = operations.get(id) ?? [];
        list.push({ field, targetId, add });
        operations.set(id, list);
      };
      if (before) {
        change(before.a, before.field, before.b, false);
        if (before.field === 'jumps') change(before.b, before.field, before.a, false);
      }
      change(next.a, next.field, next.b, true);
      await this.commit([...operations].map(([id, list]) => this.patch(id, raw => {
        for (const { field, targetId, add } of list) {
          const ids = uniqueIds(raw[field]).filter(item => item !== targetId);
          if (add) ids.push(targetId);
          raw[field] = ids;
        }
        return raw;
      })));
    });
  }

  unlink(source, target, kind) {
    return this.enqueue(() => {
      const { a, b, field } = this.edges(source, target, kind);
      const directions = field === 'jumps' ? [[a, b], [b, a]] : [[a, b]];
      const changes = directions.filter(([id, other]) => {
        const node = this.index.nodes.get(id);
        return node && !node.missing && node[field].includes(other);
      }).map(([id, other]) => this.patch(id, raw => ({ ...raw, [field]: uniqueIds(raw[field]).filter(item => item !== other) })));
      return this.commit(changes);
    });
  }

  remove(id, trash) {
    return this.enqueue(async () => {
      const node = this.index.nodes.get(id);
      if (!node) return;
      const changes = [];
      for (const other of this.index.nodes.values()) {
        if (other.missing || other.id === id || ![...other.children, ...other.jumps].includes(id)) continue;
        changes.push(this.patch(other.id, raw => ({
          ...raw, children: uniqueIds(raw.children).filter(value => value !== id),
          jumps: uniqueIds(raw.jumps).filter(value => value !== id)
        })));
      }
      const file = !node.missing && this.file(node.path);
      if (file) changes.push(this.patch(id, () => undefined));
      await this.commit(changes, async () => {
        if (file && trash) await this.app.fileManager.trashFile(file);
        this.index.missing.delete(id);
        this.plugin.removeFromHistory(id);
      });
    });
  }

  cleanDangling() {
    return this.enqueue(() => {
      const ids = new Set(this.index.dangling.map(edge => edge.from));
      return this.commit([...ids].map(id => this.patch(id, raw => {
        for (const field of ['children', 'jumps']) {
          raw[field] = uniqueIds(raw[field]).filter(other => {
            const target = this.index.nodes.get(other);
            return other !== id && Boolean(target);
          });
        }
        return raw;
      })));
    });
  }

  importGraph(data) {
    return this.enqueue(async () => {
      if (data?.format !== 'ob-brain' || data.version !== 1 || !Array.isArray(data.nodes) || data.nodes.length > 5000) {
        this.fail('图谱文件格式无效。', 'Invalid graph file.');
      }
      const paths = new Set(), ids = new Set(), changes = [];
      for (const row of data.nodes) {
        const path = text(row?.path), id = text(row?.id), title = text(row?.title);
        if (!path || path.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/.test(path) || !id || !title) {
          this.fail('导入节点缺少有效的路径、名称或 ID。', 'An imported node has an invalid path, name or ID.');
        }
        const file = this.file(normalizePath(path));
        if (!file) this.fail('找不到导入目标：'+path, 'Import target is missing: '+path);
        if (ids.has(id) || paths.has(file.path)) this.fail('导入文件含重复的 ID 或路径。', 'The import contains duplicate IDs or paths.');
        const owner = this.index.nodes.get(id);
        if (owner && !owner.missing && owner.path !== file.path) this.fail('节点 ID 已被其他文件占用：'+id, 'Another file already owns node ID '+id);
        ids.add(id);
        paths.add(file.path);
        changes.push({file,apply:raw=>{
          if (raw !== undefined && raw?.id !== id) this.fail('目标文件已有其他节点：'+path, 'The target already has a different node: '+path);
          return {...raw,id,title,level:row.level==='root'?'root':'node',
            order:Number.isFinite(row.order)?row.order:0,description:text(row.description).slice(0,200),
            icon:text(row.icon)||'file',color:/^#[0-9a-f]{6}$/i.test(row.color)?row.color:'',
            children:uniqueIds(row.children).filter(other=>other!==id),jumps:uniqueIds(row.jumps).filter(other=>other!==id)};
        }});
      }
      await this.commit(changes);
    });
  }

  stop() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}


function element(parent, tag, className, content) {
  const el = parent.ownerDocument.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = content;
  parent.append(el);
  return el;
}

function button(parent, label, action, { icon, className = '', iconOnly = false, tooltip = true } = {}) {
  const el = element(parent, 'button', 'ob-button ' + className);
  el.type = 'button';
  if (icon) setIcon(element(el, 'span', 'ob-icon'), icon);
  if (!iconOnly) element(el, 'span', '', label);
  if (tooltip) el.title = label;
  if (tooltip || iconOnly) el.setAttribute('aria-label', label);
  el.addEventListener('click', action);
  return el;
}

class FormModal extends Modal {
  constructor(plugin, title, submit, build, done) {
    super(plugin.app);
    this.plugin = plugin;
    this.titleText = title;
    this.submitText = submit;
    this.build = build;
    this.done = done;
  }

  onOpen() {
    this.setTitle(this.titleText);
    this.contentEl.classList.add('ob-form');
    const form = element(this.contentEl, 'form');
    const submit = form.ownerDocument.createElement('button');
    submit.className = 'mod-cta';
    submit.type = 'submit';
    submit.textContent = this.submitText;
    let blocked = false;
    let saving = false;
    const focus = this.build(form, (label, disabled = false) => {
      submit.textContent = label;
      blocked = disabled;
      submit.disabled = blocked || saving;
    });
    const issue = element(form, 'p', 'ob-form-error');
    issue.setAttribute('role', 'alert');
    issue.hidden = true;
    const actions = element(form, 'div', 'ob-form-actions');
    const cancel = button(actions, this.plugin.t('取消', 'Cancel'), () => this.close());
    actions.append(submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      saving = submit.disabled = cancel.disabled = true;
      issue.hidden = true;
      try {
        await this.done(new FormData(form));
        this.close();
      } catch (error) {
        issue.textContent = this.plugin.message(error);
        issue.hidden = false;
      } finally {
        saving = cancel.disabled = false;
        submit.disabled = blocked;
      }
    });
    focus?.focus();
  }

  onClose() {
    this.contentEl.replaceChildren();
  }
}

function field(form, name, label, initial = '', attributes = {}) {
  const wrapper = element(form, 'label', 'ob-field');
  element(wrapper, 'span', '', label);
  const control = element(wrapper, 'input');
  control.name = name;
  Object.assign(control, attributes);
  if (control.type === 'checkbox') control.checked = Boolean(initial);
  else control.value = initial;
  return control;
}

function selectField(form, name, label, options, initial = '') {
  const wrapper = element(form, 'label', 'ob-field');
  element(wrapper, 'span', '', label);
  const select = element(wrapper, 'select');
  select.name = name;
  for (const [value, labelText] of options) {
    const option = element(select, 'option', '', labelText);
    option.value = value;
  }
  select.value = initial;
  return select;
}

class Picker extends FuzzySuggestModal {
  constructor(plugin, items, getItemText, onSelect, placeholder) {
    super(plugin.app);
    this.items = items;
    this.labelFor = getItemText;
    this.choose = onSelect;
    this.setPlaceholder(placeholder);
  }
  getItems() { return this.items; }
  getItemText(item) { return this.labelFor(item); }
  onChooseItem(item) { this.choose(item); }
}

class BrainView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.navigation = false;
    this.plugin = plugin;
    this.nodeId = null;
    this.pendingOpen = null;
    this.opening = false;
    this.openFailure = null;
    this.isGraphOpen = false;
    this.expanded = new Set();
    this.searchItems = [];
    this.selection = 0;
    this.dragged = null;
    this.zoom = 1;
  }

  getViewType() { return VIEW; }
  getDisplayText() { return 'OB Brain'; }
  getIcon() { return 'network'; }
  t(zh, en) { return this.plugin.t(zh, en); }

  async onOpen() {
    this.isGraphOpen = true;
    this.nodeId = this.plugin.lastFocus || null;
    const root = this.contentEl;
    root.classList.add('ob-brain');
    root.replaceChildren();

    this.rootsBar = element(root, 'nav', 'ob-rootbar');
    this.rootsBar.setAttribute('aria-label', this.t('一级节点', 'Root nodes'));
    const toolbar = element(root, 'div', 'ob-toolbar');
    this.breadcrumb = element(toolbar, 'div', 'ob-breadcrumb');
    const actions = element(toolbar, 'div', 'ob-actions');
    this.linkButton = button(actions, this.t('新建连接', 'New connection'), () => this.plugin.linkForm(this.nodeId), {icon:'link', className:'mod-cta'});
    this.issue = element(root, 'div', 'ob-issue');
    this.issue.setAttribute('role', 'status');
    this.issue.hidden = true;

    const canvasShell = element(root, 'div', 'ob-canvas-shell');
    const searchBox = element(canvasShell, 'div', 'ob-search');
    setIcon(element(searchBox, 'span', 'ob-search-icon'), 'search');
    this.input = element(searchBox, 'input');
    this.input.type = 'search';
    this.input.placeholder = this.t('搜索节点名称…', 'Search nodes…');
    this.input.setAttribute('aria-label', this.input.placeholder);
    this.input.autocomplete = 'off';
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
    this.results = element(searchBox, 'div', 'ob-search-results');
    this.results.id = 'ob-search-' + generateId();
    this.results.setAttribute('role', 'listbox');
    this.input.setAttribute('aria-controls', this.results.id);
    this.results.hidden = true;

    this.viewport = element(canvasShell, 'div', 'ob-viewport');
    this.stage = element(this.viewport, 'div', 'ob-stage');
    this.cardTooltip = element(root.ownerDocument.body, 'div', 'ob-card-tooltip');
    this.cardTooltip.setAttribute('aria-hidden', 'true');
    this.cardTooltip.hidden = true;
    this.viewport.addEventListener('scroll', () => this.hideCardTooltip());
    this.enableCanvasNavigation();
    this.historyBar = element(root, 'nav', 'ob-history');
    this.historyBar.setAttribute('aria-label', this.t('最近访问', 'Recent nodes'));
    const footer = element(root, 'footer', 'ob-status');
    this.status = element(footer,'span','ob-status-text');
    this.status.setAttribute('role', 'status');
    const zoom = element(footer,'div','ob-actions ob-zoom');
    button(zoom,this.t('缩小','Zoom out'),()=>this.setZoom(this.zoom-.1),{icon:'minus',iconOnly:true});
    this.zoomButton = button(zoom,this.t('重置缩放','Reset zoom'),()=>this.setZoom(1));
    button(zoom,this.t('放大','Zoom in'),()=>this.setZoom(this.zoom+.1),{icon:'plus',iconOnly:true});
    this.setZoom(1);

    this.input.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.showSearch(), 200);
    });
    this.input.addEventListener('focus', () => { if (this.input.value) this.showSearch(); });
    this.input.addEventListener('blur', event => {
      if (!this.results.contains(event.relatedTarget)) this.hideSearch();
    });
    this.input.addEventListener('keydown', event => this.searchKey(event));
    root.addEventListener('keydown', this.viewKeys = event => {
      const typing = event.target.closest?.('input, textarea, [contenteditable]');
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.input.focus();
      }
      if (!typing && event.key === 'Backspace') {
        event.preventDefault();
        this.plugin.back(this);
      }
    });
    const window = root.ownerDocument.defaultView;
    this.observer = new window.ResizeObserver(() => {
      this.updateRootScroll?.();
      this.resizeStage();
      this.scheduleEdges();
    });
    this.observer.observe(this.stage);
    this.observer.observe(this.rootsBar);
    this.observer.observe(this.viewport);
    this.refresh();
  }

  async onClose() {
    this.isGraphOpen = false;
    this.pendingOpen = null;
    this.observer?.disconnect();
    clearTimeout(this.searchTimer);
    this.cardTooltip?.remove();
    this.contentEl.removeEventListener('keydown', this.viewKeys);
    this.contentEl.replaceChildren();
  }

  get graph() { return this.plugin.store.index; }

  refresh() {
    if (!this.isGraphOpen) return;
    const before = this.nodeId;
    if (!this.graph.nodes.has(this.nodeId)) {
      this.nodeId = this.graph.nodes.has(this.plugin.lastFocus)
        ? this.plugin.lastFocus
        : this.plugin.orderedRoots()[0]?.id ?? this.graph.nodes.keys().next().value ?? null;
    }
    const node = this.graph.nodes.get(this.nodeId);
    const path = node && !node.missing ? node.path : null;
    if (path !== this.targetPath || before !== this.nodeId) this.requestOpen(node);
    this.render();
  }

  enableCanvasNavigation() {
    const viewport = this.viewport;
    viewport.addEventListener('wheel',event=>{
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.setZoom(this.zoom + (event.deltaY < 0 ? .08 : -.08));
    },{passive:false});
    let drag = null;
    viewport.addEventListener('pointerdown',event=>{
      if(event.button!==0||event.target.closest('button, input'))return;
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-panning');
    });
    viewport.addEventListener('pointermove',event=>{
      if(drag?.id!==event.pointerId)return;
      viewport.scrollLeft=drag.left+drag.x-event.clientX;
      viewport.scrollTop=drag.top+drag.y-event.clientY;
    });
    const release=()=>{drag=null;viewport.classList.remove('is-panning');};
    viewport.addEventListener('pointerup',release);
    viewport.addEventListener('pointercancel',release);
    viewport.addEventListener('lostpointercapture',release);
  }

  setZoom(value) {
    this.zoom=Math.max(.5,Math.min(2,value));
    this.stage.style.zoom=String(this.zoom);
    this.stage.style.setProperty('--ob-stage-zoom',String(this.zoom));
    this.stage.style.minHeight=100/this.zoom+'%';
    this.resizeStage();
    this.zoomButton.querySelector(':scope > span').textContent=Math.round(this.zoom*100)+'%';
    this.scheduleEdges();
  }

  resizeStage() {
    if(this.viewport.clientWidth) this.stage.style.inlineSize=this.viewport.clientWidth/Math.min(1,this.zoom)+'px';
  }

  activate(id, { focusNote = false, back = false, keyboard = false } = {}) {
    const node = this.graph.nodes.get(id);
    if (!node || !this.isGraphOpen) return;
    const changed = this.nodeId !== id;
    const previous = this.nodeId;
    this.nodeId = id;
    if (changed) this.expanded.clear();
    if (changed || this.plugin.lastFocus !== id) this.plugin.recordFocus(previous, id, back);
    this.requestOpen(node, focusNote);
    if (changed || !this.centerCard) this.render();
    else this.renderIssue();
    if (changed) this.centerCard?.scrollIntoView({block:'nearest', inline:'center'});
    if (keyboard || changed) this.centerCard?.focus({preventScroll:true});
  }

  requestOpen(node, focus = false) {
    const file = node && !node.missing && this.plugin.store.file(node.path);
    this.targetPath = file ? file.path : null;
    this.openFailure = null;
    this.pendingOpen = file ? { id:node.id, file, focus } : null;
    if (!this.opening && this.pendingOpen) void this.drainOpens();
  }

  noteTab(path) {
    const workspace = this.app.workspace;
    const leaves = [];
    workspace.iterateRootLeaves(leaf => {
      // A truthy return value ends Obsidian's traversal.
      leaves.push(leaf);
    });
    const usable = leaf => leaf && leaf !== this.leaf && leaves.includes(leaf) &&
      ['markdown','empty'].includes(leaf.getViewState().type);
    let leaf = this.plugin.noteLeaf;
    if (!usable(leaf)) {
      const id = this.plugin.noteLeafId;
      leaf = id ? workspace.getLeafById(id) : null;
    }
    if (!usable(leaf)) {
      // Older versions left no pairing ID. Reuse the existing split showing the focus note.
      const graphIndex = leaves.indexOf(this.leaf);
      leaf = graphIndex < 0 ? null : leaves.slice(graphIndex+1).find(candidate => {
        if (this.leaf.parent && candidate.parent === this.leaf.parent) return false;
        const state = candidate.getViewState();
        return state.type === 'markdown' && !state.pinned && state.state?.file === path;
      });
    }
    if (!leaf) leaf = workspace.createLeafBySplit(this.leaf, 'vertical', false);
    this.plugin.noteLeaf = leaf;
    const id = text(leaf.id);
    if (id && id !== this.plugin.noteLeafId) {
      this.plugin.noteLeafId = id;
      this.plugin.persist();
    }
    return leaf;
  }

  async drainOpens() {
    this.opening = true;
    const workspace = this.app.workspace;
    try {
      if (workspace.layoutReady === false) await new Promise(resolve => workspace.onLayoutReady(resolve));
      while (this.isGraphOpen && this.pendingOpen) {
        const request = this.pendingOpen;
        this.pendingOpen = null;
        try {
          const leaf = this.noteTab(request.file.path);
          const state = leaf.getViewState();
          if (state.state?.file !== request.file.path) {
            if (state.pinned) throw new Error(this.t('请取消固定右侧笔记页签后重试。','Unpin the right note tab and retry.'));
            await leaf.openFile(request.file, {active:false});
          }
          if (!this.isGraphOpen || this.pendingOpen || this.nodeId !== request.id) continue;
          await workspace.revealLeaf(leaf);
          if (request.focus && !this.pendingOpen && this.nodeId === request.id) workspace.setActiveLeaf(leaf, { focus:true });
        } catch (error) {
          if (!this.pendingOpen && this.isGraphOpen && this.nodeId === request.id) {
            this.openFailure = this.plugin.message(error);
            this.renderIssue();
          }
        }
      }
    } finally {
      this.opening = false;
    }
  }

  searchKey(event) {
    if (event.isComposing) return;
    if (!['Escape','ArrowDown','ArrowUp','Enter'].includes(event.key)) return;
    event.preventDefault();
    clearTimeout(this.searchTimer);
    if (event.key === 'Escape') { this.hideSearch(); return; }
    if (this.searchQuery !== this.input.value || this.results.hidden) this.showSearch();
    if (event.key === 'Enter') {
      const node = this.searchItems[this.selection];
      if (node) this.chooseSearch(node);
      return;
    }
    if (!this.searchItems.length) return;
    this.selection = (this.selection + this.searchItems.length + (event.key === 'ArrowDown' ? 1 : -1)) % this.searchItems.length;
    this.renderSearchSelection(true);
  }

  chooseSearch(node) {
    this.hideSearch();
    this.input.value = '';
    this.input.blur();
    this.activate(node.id, {keyboard:true});
    this.centerCard?.focus({preventScroll:true});
  }

  hideSearch() {
    clearTimeout(this.searchTimer);
    this.results.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  renderSearchSelection(scroll = false) {
    this.input.removeAttribute('aria-activedescendant');
    [...this.results.querySelectorAll('[role=option]')].forEach((row, i) => {
      const selected = i === this.selection;
      row.setAttribute('aria-selected', String(selected));
      if (!selected) return;
      this.input.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({block:'nearest'});
    });
  }

  showSearch() {
    this.searchQuery = this.input.value;
    const query = this.searchQuery.trim();
    if (!query) return this.hideSearch();
    const {searchAliases, searchScope} = this.plugin.settings;
    const ids = searchScope === 'local' ? this.graph.neighborhood(this.nodeId) : null;
    this.searchItems = this.graph.search(query, { aliases:searchAliases, ids, recent:this.plugin.history });
    this.selection = 0;
    this.results.replaceChildren();
    this.results.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    if (!this.searchItems.length) {
      element(this.results, 'p', 'ob-subtle', this.t('未找到匹配节点。', 'No matching nodes.'));
      this.renderSearchSelection();
      return;
    }
    this.searchItems.forEach((node, i) => {
      const row = element(this.results, 'div', 'ob-search-row');
      row.setAttribute('role', 'option');
      row.id = this.results.id + '-' + i;
      setIcon(element(row, 'span', 'ob-icon'), node.missing ? 'triangle-alert' : node.icon);
      const body = element(row, 'span', 'ob-result-body');
      const name = element(body, 'span');
      const start = fold(node.title).indexOf(fold(query));
      if (start < 0) name.textContent = node.title;
      else {
        name.append(node.title.slice(0,start));
        element(name, 'mark', '', node.title.slice(start,start+query.length));
        name.append(node.title.slice(start+query.length));
      }
      element(body, 'small', 'ob-subtle', node.path + (node.missing ? this.t(' · 笔记缺失',' · Note missing') : ''));
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => this.chooseSearch(node));
    });
    this.renderSearchSelection();
  }

  render() {
    if (!this.isGraphOpen) return;
    const active = this.graph.nodes.get(this.nodeId);
    const focusedId = this.contentEl.ownerDocument.activeElement?.dataset?.node;
    const paths = active ? this.graph.pathsToRoots(active.id) : new Map();
    this.renderRoots(paths);
    this.renderHistory();
    this.renderGraph(active, paths);
    this.renderIssue();
    this.linkButton.disabled = !active || active.missing;
    this.updateRootScroll?.();
    this.status.textContent = this.plugin.store.scanning ? this.t('正在建立节点索引…', 'Indexing notes…') :
      this.t(this.graph.nodes.size + ' 个节点', this.graph.nodes.size + ' nodes');
    if (focusedId) [...this.contentEl.querySelectorAll('[data-node]')].find(el => el.dataset.node === focusedId)?.focus({preventScroll:true});
  }

  renderRoots(paths) {
    const bar = this.rootsBar;
    const left = bar.querySelector('.ob-strip')?.scrollLeft ?? 0;
    bar.replaceChildren();
    element(bar,'span','ob-strip-label',this.t('一级节点','Roots'));
    const shift = direction => rail.scrollBy({left:direction*170,behavior:'smooth'});
    const prev = button(bar, this.t('向左滚动一级节点','Scroll roots left'), () => shift(-1), {icon:'chevron-left',iconOnly:true});
    const rail = element(bar, 'div', 'ob-strip');
    const roots = this.plugin.orderedRoots();
    if (!roots.length) element(rail,'span','ob-subtle',this.t('还没有一级节点','No root nodes yet'));
    bar.classList.toggle('has-many-roots',roots.length>30);
    for (const node of roots.slice(0,30)) {
      const chip = this.chip(rail, node, 'ob-root');
      if (paths.has(node.id) && node.id !== this.nodeId) {
        chip.classList.add('is-ancestor');
        chip.title = paths.get(node.id).map(id => this.graph.nodes.get(id)?.title).join(' › ');
      }
      if (this.plugin.settings.rootSort === 'manual' && !node.missing) {
        chip.draggable = true;
        chip.addEventListener('dragstart', event => { this.dragged = node.id; event.dataTransfer.setData('text/plain',node.id); });
        chip.addEventListener('dragend', () => { this.dragged = null; chip.classList.remove('is-drop'); });
        chip.addEventListener('dragover', event => { if(this.dragged) { event.preventDefault(); chip.classList.add('is-drop'); } });
        chip.addEventListener('dragleave', () => chip.classList.remove('is-drop'));
        chip.addEventListener('drop', event => {
          event.preventDefault();
          chip.classList.remove('is-drop');
          if (this.dragged) this.plugin.run(this.plugin.store.reorder(this.dragged, node.id));
          this.dragged = null;
        });
      }
    }
    const next = button(bar, this.t('向右滚动一级节点','Scroll roots right'), () => shift(1), {icon:'chevron-right',iconOnly:true});
    const more = button(bar,this.t('更多一级节点','More root nodes'),()=>{
      new Picker(this.plugin,roots,node=>node.title+' · '+node.path,node=>this.activate(node.id,{keyboard:true}),
        this.t('查找一级节点…','Find a root…')).open();
    },{icon:'ellipsis',iconOnly:true});
    more.classList.add('ob-more-roots');
    more.hidden = !roots.length;
    button(bar,this.t('新建一级节点','Create root node'),()=>this.plugin.nodeForm({root:true}),
      {icon:'plus',iconOnly:true,className:'ob-add'});
    rail.scrollLeft = left;
    const scrollState = () => {
      prev.disabled = rail.scrollLeft <= 0;
      next.disabled = rail.scrollLeft + rail.clientWidth + 1 >= rail.scrollWidth;
    };
    this.updateRootScroll = scrollState;
    rail.addEventListener('scroll', scrollState);
    scrollState();
  }

  chip(parent, node, className) {
    const chip = button(parent, node.title, event => this.activate(node.id, {keyboard:event.detail===0}), {className});
    chip.dataset.node = node.id;
    if (node.color) chip.style.setProperty('--ob-node-color', node.color);
    if (node.id === this.nodeId) chip.setAttribute('aria-current', 'true');
    this.context(chip,node);
    return chip;
  }

  renderHistory() {
    const bar = this.historyBar;
    const left = bar.querySelector('.ob-strip')?.scrollLeft ?? 0;
    bar.replaceChildren();
    element(bar,'span','ob-strip-label',this.t('最近访问','Recent'));
    const rail = element(bar,'div','ob-strip');
    const history = this.plugin.history.filter(entry => entry.id !== this.nodeId && this.graph.nodes.has(entry.id));
    element(bar,'small','ob-counter',history.length + '/' + this.plugin.settings.historyLimit);
    if (!history.length) element(rail,'span','ob-subtle',this.t('暂无历史记录','No recent nodes'));
    for (const entry of history) this.chip(rail,this.graph.nodes.get(entry.id),'ob-recent');
    rail.scrollLeft = left;
    const clear = button(bar,this.t('清空历史','Clear history'), () => this.plugin.confirmClear(), {icon:'trash-2',iconOnly:true});
    clear.disabled = !history.length;
  }

  renderIssue() {
    const node = this.graph.nodes.get(this.nodeId);
    this.issue.replaceChildren();
    this.issue.hidden = true;
    if (!node) return;
    const missing = node.missing || !this.plugin.store.file(node.path);
    if (!missing && !this.openFailure) return;
    this.issue.hidden = false;
    element(this.issue,'span','',missing ? this.t('绑定笔记缺失，右侧页签未切换。','The note is missing. The right tab was left open.') :
      this.t('打开笔记失败：','Could not open the note: ') + this.openFailure);
    button(this.issue,missing?this.t('重新绑定','Rebind'):this.t('重试','Retry'), () => {
      if (missing) this.plugin.nodeForm({rebind:node});
      else { this.requestOpen(node); this.renderIssue(); }
    });
  }

  renderGraph(active, paths) {
    this.hideCardTooltip();
    this.stage.replaceChildren();
    this.breadcrumb.replaceChildren();
    this.centerCard = null;
    this.drawTargets = [];
    this.edges = null;
    if (!active) {
      this.stage.classList.add('is-empty');
      element(this.breadcrumb,'strong','',this.t('关系图谱','Relationship graph'));
      const empty = element(this.stage,'div','ob-empty');
      setIcon(element(empty,'span','ob-brand-icon'),'network');
      element(empty,'h3','',this.plugin.store.scanning ? this.t('正在读取知识库','Reading your vault') : this.t('还没有知识节点','No knowledge nodes yet'));
      button(empty,this.t('创建第一个节点','Create first node'),() => this.plugin.nodeForm(),{icon:'plus',className:'mod-cta'});
      return;
    }
    this.stage.classList.remove('is-empty');
    const path = [...paths.values()].sort((a,b) => a.length-b.length)[0] ?? [active.id];
    path.forEach((id,index) => {
      if (index) element(this.breadcrumb,'span','ob-subtle','›');
      const node = this.graph.nodes.get(id);
      if (id === active.id) element(this.breadcrumb,'span','ob-crumb-current',node.title).setAttribute('aria-current','location');
      else button(this.breadcrumb,node.title,() => this.activate(id),{className:'ob-crumb'});
    });

    this.edges = this.stage.ownerDocument.createElementNS(SVG,'svg');
    this.edges.classList.add('ob-edges');
    this.edges.setAttribute('aria-hidden','true');
    this.stage.append(this.edges);

    const relatives = this.graph.relatives(active.id);
    this.zone('parent',relatives.parent);
    this.zone('jump',relatives.jump);
    const middle = element(this.stage,'div','ob-center-zone');
    this.centerCard = this.card(middle,active,'center');
    this.zone('sibling',relatives.sibling);
    this.zone('child',relatives.child);
    this.scheduleEdges();
  }

  zone(kind, nodes) {
    const name = this.t(...LABELS[kind]);
    const zone = element(this.stage,'section','ob-zone ob-zone-' + kind);
    zone.dataset.relation = kind;
    const heading = element(zone,'span','',name);
    heading.hidden = true;
    heading.id = 'ob-zone-title-' + generateId();
    zone.setAttribute('aria-labelledby', heading.id);
    const list = element(zone,'div','ob-zone-list');
    const limit = ZONE_LIMITS[kind] ?? nodes.length;
    const expanded = this.expanded.has(kind);
    const visible = expanded ? nodes : nodes.slice(0,limit);
    if (kind === 'sibling' && visible.length > SIBLINGS_PER_COLUMN) {
      zone.classList.add('is-multicolumn');
      list.style.gridTemplateRows = 'repeat(' + SIBLINGS_PER_COLUMN + ', auto)';
    }
    for (const item of visible) this.card(list,item.node ?? item,kind);
    if (nodes.length > limit) {
      const remaining = nodes.length - limit;
      const more = element(zone,'button','ob-button ob-inline',
        expanded ? this.t('收起','Collapse') : this.t('+'+remaining+' 更多','+'+remaining+' more'));
      more.type = 'button';
      more.setAttribute('aria-expanded', String(expanded));
      more.addEventListener('click', () => {
        if (expanded) this.expanded.delete(kind);
        else this.expanded.add(kind);
        this.render();
      });
    }
    if (kind === 'jump') this.dropTarget(zone, id => {
      if (id !== this.nodeId) this.plugin.run(this.plugin.store.link(this.nodeId,id,'jump'));
    });
  }

  card(parent,node,kind) {
    const card = element(parent,'button','ob-card ob-card-' + kind);
    card.type = 'button';
    card.dataset.node = node.id;
    if (kind === 'center') card.setAttribute('aria-current','true');
    if (node.missing) card.classList.add('is-missing');
    if (node.color) card.style.setProperty('--ob-node-color',node.color);
    const words = element(card,'span','ob-card-text');
    const title = element(words,'span','ob-card-title',node.title);
    if (node.missing) element(words,'small','',this.t('笔记缺失','Note missing'));
    else if (kind === 'center') {
      if (node.tags.length) element(words,'small','ob-tags',node.tags.slice(0,6).join(' '));
    } else if (kind === 'jump' && node.children.length) {
      element(words,'small','',this.t(node.children.length+' 个子节点',node.children.length+' children'));
    }
    const showTooltip = event => this.showCardTooltip(event, title);
    card.addEventListener('pointerenter', showTooltip);
    card.addEventListener('pointermove', showTooltip);
    card.addEventListener('pointerleave', () => this.hideCardTooltip());
    card.addEventListener('pointerdown', () => this.hideCardTooltip());
    if (kind !== 'center') this.drawTargets.push({card,kind});
    card.addEventListener('click',event => this.activate(node.id,{keyboard:event.detail===0}));
    card.addEventListener('dblclick',() => this.activate(node.id,{focusNote:true}));
    this.context(card,node,kind);
    if (kind === 'child' && !node.missing) {
      card.draggable = true;
      card.addEventListener('dragstart',event=>{this.dragged=node.id;event.dataTransfer.setData('text/plain',node.id);});
      card.addEventListener('dragend',()=>{this.dragged=null;this.stage.querySelectorAll('.is-drop').forEach(el=>el.classList.remove('is-drop'));});
    }
    if (!node.missing) this.dropTarget(card,id => {
      if (id === node.id) return;
      if (kind === 'jump') this.plugin.run(this.plugin.store.link(this.nodeId,id,'jump'));
      else this.plugin.run(this.plugin.store.link(node.id,id,'child'));
    });
    return card;
  }

  showCardTooltip(event, title) {
    if (event.buttons || event.pointerType === 'touch' || this.dragged ||
        (title.scrollWidth <= title.clientWidth && title.scrollHeight <= title.clientHeight)) {
      this.hideCardTooltip();
      return;
    }
    const tooltip = this.cardTooltip;
    const {innerWidth, innerHeight} = tooltip.ownerDocument.defaultView;
    if (tooltip.textContent !== title.textContent) tooltip.textContent = title.textContent;
    tooltip.hidden = false;
    const x = Math.max(4, Math.min(event.clientX + 12, innerWidth - tooltip.offsetWidth - 4));
    const y = event.clientY + 16 + tooltip.offsetHeight <= innerHeight - 4
      ? event.clientY + 16
      : Math.max(4, event.clientY - tooltip.offsetHeight - 8);
    tooltip.style.transform = `translate(${x}px, ${y}px)`;
  }

  hideCardTooltip() {
    if (this.cardTooltip) this.cardTooltip.hidden = true;
  }

  dropTarget(el, drop) {
    el.addEventListener('dragover',event => {
      if (!this.dragged) return;
      event.stopPropagation();
      event.preventDefault();
      el.classList.add('is-drop');
    });
    el.addEventListener('dragleave',event => { if (!el.contains(event.relatedTarget)) el.classList.remove('is-drop'); });
    el.addEventListener('drop',event => {
      if (!this.dragged) return;
      event.stopPropagation();
      event.preventDefault();
      el.classList.remove('is-drop');
      const id = this.dragged;
      this.dragged = null;
      drop(id);
    });
  }

  context(el,node,kind) {
    el.addEventListener('contextmenu',event => { event.preventDefault(); this.menu(node,kind,event); });
    el.addEventListener('keydown',event => {
      if (event.key==='ContextMenu' || (event.shiftKey&&event.key==='F10')) {
        event.preventDefault();
        this.menu(node,kind,el.getBoundingClientRect());
      }
    });
  }

  menu(node,kind,position) {
    const menu = new Menu();
    const add = (zh,en,icon,action) => menu.addItem(item=>item.setTitle(this.t(zh,en)).setIcon(icon).onClick(action));
    if (node.missing) add('重新绑定笔记','Rebind note','file-plus',()=>this.plugin.nodeForm({rebind:node}));
    else {
      add('编辑节点','Edit node','pencil',()=>this.plugin.editNodeForm(node));
      add('新建连接','New connection','link',()=>this.plugin.linkForm(node.id));
      add('管理关系','Manage relations','list-tree',()=>this.plugin.relationsForm(node.id));
      if (node.level==='root') add('移除一级入口','Unpin root','pin-off',()=>this.plugin.run(this.plugin.store.pin(node.id,false)));
      else add('固定到一级节点栏','Pin as root','pin',()=>this.plugin.run(this.plugin.store.pin(node.id,true)));
    }
    if (['parent','child','jump'].includes(kind)) add('断开与当前焦点的关系','Disconnect from focus','unlink',()=>this.plugin.run(this.plugin.store.unlink(this.nodeId,node.id,kind)));
    add('删除节点…','Delete node…','trash-2',()=>this.plugin.deleteForm(node));
    if ('clientX' in position) menu.showAtMouseEvent(position);
    else menu.showAtPosition({x:position.left,y:position.bottom});
  }

  scheduleEdges() {
    if (!this.isGraphOpen || this.drawQueued) return;
    this.drawQueued = true;
    this.stage.ownerDocument.defaultView.requestAnimationFrame(() => {
      this.drawQueued = false;
      if (this.isGraphOpen) this.drawEdges();
    });
  }

  drawEdges() {
    if (!this.edges || !this.centerCard) return;
    const bounds = this.stage.getBoundingClientRect();
    const center = this.centerCard.getBoundingClientRect();
    const zoom = this.zoom || 1;
    const offsetX = x => (x-bounds.left)/zoom;
    const offsetY = y => (y-bounds.top)/zoom;
    const parts = [];
    const point = (rect,axis,toward) => axis==='x'
      ? [offsetX(toward>0?rect.right:rect.left),offsetY((rect.top+rect.bottom)/2)]
      : [offsetX((rect.left+rect.right)/2),offsetY(toward>0?rect.bottom:rect.top)];
    const pathFor = (data,kind) => {
      const path = this.stage.ownerDocument.createElementNS(SVG,'path');
      path.setAttribute('d',data);
      path.setAttribute('class','ob-wire ob-wire-' + kind);
      parts.push(path);
    };
    for (const {card,kind} of this.drawTargets) {
      const rect = card.getBoundingClientRect();
      const lateral = kind==='jump'||kind==='sibling';
      const axis = lateral && (rect.right <= center.left || rect.left >= center.right) ? 'x':'y';
      const sign = axis==='x' ? (rect.left > center.left ? 1 : -1) : (rect.top > center.top ? 1 : -1);
      const [sx,sy] = point(center,axis,sign), [ex,ey] = point(rect,axis,-sign);
      const mid = axis==='x'?(sx+ex)/2:(sy+ey)/2;
      pathFor(axis==='x'?`M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ey}, ${ex} ${ey}`:`M ${sx} ${sy} C ${sx} ${mid}, ${ex} ${mid}, ${ex} ${ey}`,kind);
      if (kind==='jump') {
        const arrow = (x,y,d) => axis==='x'?`M ${x+d*7} ${y-4} L ${x} ${y} L ${x+d*7} ${y+4}`:`M ${x-4} ${y+d*7} L ${x} ${y} L ${x+4} ${y+d*7}`;
        pathFor(arrow(sx,sy,sign),'arrow');
        pathFor(arrow(ex,ey,-sign),'arrow');
      }
    }
    this.edges.replaceChildren(...parts);
  }
}


class BrainSettings extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app,plugin);
    this.brain = plugin;
  }

  display() {
    const {containerEl,brain} = this;
    const t = (zh,en) => brain.t(zh,en);
    containerEl.replaceChildren();
    const heading = (zh,en) => new Setting(containerEl).setName(t(zh,en)).setHeading();
    const change = (key,value) => {
      brain.settings[key]=value;
      brain.persist();
      brain.refreshViews();
    };
    heading('节点与笔记','Nodes and notes');
    new Setting(containerEl).setName(t('新笔记目录','New notes folder'))
      .setDesc(t('相对于当前知识库。留空时创建到库根目录。','Relative to the vault. Clear the value to use the vault root.'))
      .addText(control=>control.setValue(brain.settings.folder).onChange(value=>change('folder',value.trim())));
    new Setting(containerEl).setName(t('从库内标签创建入口','Create roots from vault tags'))
      .addButton(control=>control.setButtonText(t('扫描标签','Scan tags')).onClick(()=>brain.tagForm()));
    new Setting(containerEl).setName(t('重命名时同步文件名','Rename the file with the node'))
      .addToggle(control=>control.setValue(brain.settings.renameFile).onChange(value=>change('renameFile',value)));
    heading('图谱与搜索','Graph and search');
    new Setting(containerEl).setName(t('一级节点排序','Root order')).addDropdown(control=>control
      .addOptions({manual:t('手动','Manual'),name:t('名称','Name'),recent:t('最近访问','Recently opened')})
      .setValue(brain.settings.rootSort).onChange(value=>change('rootSort',value)));
    new Setting(containerEl).setName(t('搜索范围','Search scope')).addDropdown(control=>control
      .addOptions({vault:t('全库节点','All nodes'),local:t('当前子图，深度 2','Local graph, depth 2')})
      .setValue(brain.settings.searchScope).onChange(value=>change('searchScope',value)));
    new Setting(containerEl).setName(t('搜索时包含笔记别名','Include note aliases in search'))
      .addToggle(control=>control.setValue(brain.settings.searchAliases).onChange(value=>change('searchAliases',value)));
    new Setting(containerEl).setName(t('界面语言','Interface language'))
      .setDesc(t('重新打开图谱后应用到所有界面文字。','Reopen the graph to apply the language to all labels.'))
      .addDropdown(control=>control.addOptions({auto:t('跟随 Obsidian','Follow Obsidian'),zh:'简体中文',en:'English'})
        .setValue(brain.settings.language).onChange(value=>{change('language',value); this.display();}));
    heading('最近访问','Recent nodes');
    new Setting(containerEl).setName(t('历史记录容量','History capacity')).addSlider(control=>control
      .setLimits(5,20,1).setDynamicTooltip().setValue(brain.settings.historyLimit).onChange(value=>{
        brain.history=brain.history.slice(0,value);change('historyLimit',value);
      }));
    heading('数据','Data');
    new Setting(containerEl).setName(t('重建索引','Rebuild index'))
      .addButton(control=>control.setButtonText(t('扫描知识库','Scan vault')).onClick(()=>brain.rebuild()));
    new Setting(containerEl).setName(t('数据健康检查','Data health'))
      .setDesc(t('查看悬挂链接和重复节点 ID。','Inspect dangling links and duplicate node IDs.'))
      .addButton(control=>control.setButtonText(t('检查','Inspect')).onClick(()=>brain.healthForm()));
    new Setting(containerEl).setName(t('图谱 JSON','Graph JSON'))
      .setDesc(t('导入以当前库内已有的 Markdown 文件为目标，导出不包含笔记正文。','Import targets existing Markdown files in this vault. Exports omit note bodies.'))
      .addButton(control=>control.setButtonText(t('导出','Export')).onClick(()=>brain.exportGraph()))
      .addButton(control=>control.setButtonText(t('导入','Import')).onClick(()=>brain.importForm()));
    new Setting(containerEl).setName(t('清除视图数据','Clear view data'))
      .setDesc(t('重置设置和访问记录。笔记文件内的节点与关系会保留。','Reset settings and recent nodes. Note files and their graph metadata are preserved.'))
      .addButton(control=>control.setWarning().setButtonText(t('重置','Reset')).onClick(()=>brain.resetForm()));
  }
}

class OBBrain extends Plugin {
  async onload() {
    const data = await this.loadData() ?? {};
    this.settings={...DEFAULTS,...data.settings};
    this.settings.historyLimit=limit(this.settings.historyLimit,5,20,10);
    this.history=(Array.isArray(data.history)?data.history:[]).filter(entry=>entry && text(entry.id) && Number.isFinite(entry.at)).slice(0,this.settings.historyLimit);
    this.lastFocus=text(data.lastFocus);
    this.lastFocusAt=Number.isFinite(data.lastFocusAt)?data.lastFocusAt:0;
    this.noteLeafId=text(data.noteLeafId);
    this.saveQueue=Promise.resolve();
    this.store=new VaultGraph(this);
    for (const node of Array.isArray(data.missing)?data.missing:[]) {
      if (node && text(node.id) && text(node.path) && Array.isArray(node.children) && Array.isArray(node.jumps)) this.store.index.missing.set(node.id,{...node,missing:true});
    }
    this.missingSnapshot=JSON.stringify([...this.store.index.missing.values()]);
    this.registerView(VIEW,leaf=>new BrainView(leaf,this));
    this.store.start();
    this.addRibbonIcon('network',this.t('打开 OB Brain','Open OB Brain'),()=>this.run(this.openGraph()));
    const commands = [
      ['open','打开图谱','Open graph',()=>this.openGraph()],
      ['switch','按名称激活节点','Find a node',async()=>{const view=await this.openGraph();view?.input?.focus();}],
      ['create-from-note','从当前笔记创建节点','Create node from current note',()=>this.fromCurrent()],
      ['root-pin','将焦点设为一级节点','Pin focused node as root',()=>{const id=this.currentView()?.nodeId;if(id)return this.store.pin(id,true);}],
      ['back','返回上一节点','Go to previous node',()=>this.back(this.currentView())],
      ['history-clear','清空访问历史','Clear recent nodes',()=>this.confirmClear()],
      ['reindex','重建图谱索引','Rebuild graph index',()=>this.rebuild()]
    ];
    for (const [id,zh,en,action] of commands) this.addCommand({id,name:this.t(zh,en),callback:()=>this.run(Promise.resolve().then(action))});
    this.addSettingTab(new BrainSettings(this));
  }

  get zh() {
    const preference=this.settings?.language??'auto';
    const appLanguage=typeof getLanguage==='function'?getLanguage():globalThis.navigator?.language;
    return preference==='zh'||(preference==='auto'&&String(appLanguage).toLowerCase().startsWith('zh'));
  }
  t(zh,en) { return this.zh?zh:en; }
  message(error) { return error instanceof Error?error.message:String(error); }
  report(error) { new Notice(this.message(error),6000); }
  run(promise) { return Promise.resolve(promise).catch(error=>this.report(error)); }

  onunload() {
    this.store?.stop();
  }

  views() { return this.app.workspace.getLeavesOfType(VIEW).map(leaf=>leaf.view).filter(view=>view instanceof BrainView); }
  currentView() { return this.app.workspace.getActiveViewOfType(BrainView)??this.views()[0]; }

  async openGraph() {
    if (!this.graphOpening) {
      this.graphOpening=(async()=>{
        let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];
        if(!leaf){
          leaf=this.app.workspace.getLeaf('tab');
          await leaf.setViewState({type:VIEW,active:true});
        }
        await this.app.workspace.revealLeaf(leaf);
        this.app.workspace.setActiveLeaf(leaf,{focus:true});
        return leaf.view instanceof BrainView?leaf.view:null;
      })().finally(()=>{this.graphOpening=null;});
    }
    return this.graphOpening;
  }

  refreshViews() {
    const missing=JSON.stringify([...this.store.index.missing.values()]);
    if(missing!==this.missingSnapshot){this.missingSnapshot=missing;this.persist();}
    for (const view of this.views()) view.refresh();
  }

  focusTime(id) {
    return id===this.lastFocus?this.lastFocusAt:this.history.find(item=>item.id===id)?.at;
  }

  orderedRoots() {
    const roots=this.store.index.roots();
    const method=this.settings.rootSort;
    const times=new Map(this.history.map(item=>[item.id,item.at]));
    times.set(this.lastFocus,this.lastFocusAt);
    return roots.sort((a,b)=>(method==='manual'?a.order-b.order:method==='recent'?(times.get(b.id)??0)-(times.get(a.id)??0):0)||
      compareText(a.title,b.title)||compareText(a.path,b.path));
  }

  persist() {
    const payload=clone({
      settings:this.settings,history:this.history,lastFocus:this.lastFocus,lastFocusAt:this.lastFocusAt,noteLeafId:this.noteLeafId,
      missing:[...this.store.index.missing.values()]
    });
    this.saveQueue=this.saveQueue.then(()=>this.saveData(payload)).catch(error=>this.report(error));
    return this.saveQueue;
  }

  recordFocus(previous,id,back) {
    const previousTime=this.focusTime(previous);
    let history=this.history.filter(item=>item.id!==id);
    if (!back && previous && previous!==id) history=[{id:previous,at:previousTime??Date.now()},...history.filter(item=>item.id!==previous)];
    this.history=history.slice(0,this.settings.historyLimit);
    this.lastFocus=id;
    this.lastFocusAt=Date.now();
    this.persist();
  }

  removeFromHistory(id) {
    this.history=this.history.filter(item=>item.id!==id);
    if (this.lastFocus===id) { this.lastFocus='';this.lastFocusAt=0; }
    this.persist();
    for (const view of this.views()) if(view.isGraphOpen)view.render();
  }

  back(view) {
    if (!view) return;
    const entry=this.history.find(item=>item.id!==view.nodeId&&this.store.index.nodes.has(item.id));
    if(entry)view.activate(entry.id,{back:true,keyboard:true});
  }

  modal(title,submit,build,done) {
    new FormModal(this,title,submit,build,done).open();
  }

  notesNamed(title) {
    const name=fold(title.trim());
    return name ? this.app.vault.getMarkdownFiles().filter(file=>fold(file.basename)===name) : [];
  }

  canBindNote(file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.[FIELD] === undefined &&
      !this.store.index.files.has(file.path);
  }

  filePicker(choose) {
    const available=this.app.vault.getMarkdownFiles().filter(file=>this.canBindNote(file));
    if(!available.length){new Notice(this.t('没有可绑定的现有 Markdown 笔记。','No unbound Markdown notes are available.'));return;}
    new Picker(this,available,file=>file.path,choose,this.t('选择已有 Markdown 笔记…','Select an existing Markdown note…')).open();
  }

  tagForm() {
    const t=(zh,en)=>this.t(zh,en);
    const counts=new Map();
    const rootNames=new Set(this.store.index.roots().map(node=>fold(node.title)));
    for(const file of this.app.vault.getMarkdownFiles()){
      const cache=this.app.metadataCache.getFileCache(file);
      for(const tag of new Set(cache?getAllTags(cache)??[]:[])){
        const name=tag.replace(/^#/,'');
        if(!name||rootNames.has(fold(name)))continue;
        counts.set(name,(counts.get(name)??0)+1);
      }
    }
    const items=[...counts].sort((a,b)=>b[1]-a[1]||compareText(a[0],b[0]));
    if(!items.length){
      new Notice(t('没有可用于新入口的标签。','No tags available for new roots.'));
      return;
    }
    this.modal(t('从标签创建一级节点','Create roots from tags'),t('创建所选入口','Create selected roots'),form=>{
      element(form,'p','ob-subtle',t('为所选标签创建入口及对应的 Markdown 笔记。','Create a root and a new Markdown note for each selected tag.'));
      const list=element(form,'div','ob-tag-picker');
      for(const [i,[name,count]] of items.entries())field(list,'tag-'+i,'#'+name+' · '+count,false,{type:'checkbox'});
    },async data=>{
      const selected=items.flatMap(([name],i)=>data.has('tag-'+i)?[name]:[]);
      if(!selected.length)throw new Error(t('至少选择一个标签。','Select at least one tag.'));
      for(const title of selected){
        if(this.store.hasNodeName(title))continue;
        await this.store.create({title,root:true});
      }
      await this.openGraph();
    });
  }

  fromCurrent() {
    const file=this.app.workspace.getActiveFile();
    if(!(file instanceof TFile)||file.extension!=='md'){
      new Notice(this.t('请先打开一篇 Markdown 笔记。','Open a Markdown note first.'));
      return;
    }
    const existing=this.store.index.files.get(file.path);
    if(existing)return this.openGraph().then(view=>view?.activate(existing.id));
    const heading=this.app.metadataCache.getFileCache(file)?.headings?.find(item=>item.level===1)?.heading;
    this.nodeForm({existing:file,title:heading||file.basename,source:this.currentView()?.nodeId});
  }

  findNodeSuggestions(query, excludeId) {
    if (!query) return [];
    const index=this.store.index;
    const ids=new Set([...index.nodes.values()].filter(node=>!node.missing && node.id!==excludeId).map(node=>node.id));
    return index.search(query,{ids});
  }

  renderNodeSuggestions(container, nodes, onPick) {
    for (const node of nodes) {
      button(container,node.title+' · '+node.path,()=>onPick(node),{className:'ob-connect-result',tooltip:false});
    }
  }

  editNodeMatches(title) {
    const key=fold(title.trim());
    if(!key)return [];
    const notes=this.notesNamed(title);
    const paths=new Set(notes.map(file=>file.path));
    const nodes=[...this.store.index.nodes.values()].filter(node=>
      fold(node.title.trim())===key || paths.has(node.path));
    return [
      ...nodes.map(node=>({path:node.path,node})),
      ...notes.filter(file=>this.canBindNote(file)).map(file=>({path:file.path,file}))
    ].sort((a,b)=>compareText(a.path,b.path));
  }

  editNodeForm(node) {
    const t=(zh,en)=>this.t(zh,en);
    const save=t('保存','Save');
    const isChanged=title=>title!==node.title.trim();
    let manualNote=null;
    let selectedNode=null;

    this.modal(t('编辑节点','Edit node'),save,(form,setSubmitLabel)=>{
      form.className='ob-node-form ob-edit-node-form';
      const name=field(form,'title',t('节点名称','Node name'),node.title,{
        type:'text',className:'ob-node-name',required:true,maxLength:110
      });
      const suggestions=element(form,'div','ob-connect-targets');
      const binding=element(form,'div','ob-field');
      element(binding,'span','',t('关联笔记','Linked note'));
      const status=element(binding,'p','ob-note-match-warning');
      status.setAttribute('aria-live','polite');
      const current=element(binding,'span','ob-subtle');
      const choices=element(binding,'div');
      const actions=element(binding,'div','ob-actions');
      let matchSelect=null;
      const newNote=button(actions,t('创建新笔记','Create new note'),()=>{
        if(newNote.disabled)return;
        manualNote=null;
        update();
      },{icon:'file-plus',tooltip:false});
      const linkNote=button(actions,t('关联已有笔记','Link existing note'),()=>{
        if(linkNote.disabled)return;
        if(matchSelect){
          matchSelect.focus();
          return;
        }
        this.filePicker(file=>{
          manualNote=file;
          update();
        });
      },{icon:'file-search',className:'ob-existing-note',tooltip:false});
      const keepNote=button(actions,t('保留当前笔记','Keep current note'),()=>{
        manualNote=null;
        update();
      },{icon:'undo-2',tooltip:false});

      const update=()=>{
        const title=name.value.trim();
        const changed=Boolean(title) && isChanged(title);
        suggestions.replaceChildren();
        if(changed && !selectedNode){
          this.renderNodeSuggestions(suggestions,this.findNodeSuggestions(title),match=>{
            selectedNode=match;
            name.value=match.title;
            update();
            name.focus();
          });
        }
        suggestions.hidden=!suggestions.children.length;
        const matches=selectedNode ? [{path:selectedNode.path,node:selectedNode}]
          : changed ? this.editNodeMatches(title) : [];
        choices.replaceChildren();
        choices.hidden=matches.length<2;
        matchSelect=null;
        newNote.disabled=!changed || matches.length>0;
        newNote.setAttribute('aria-pressed',String(!newNote.disabled));
        linkNote.disabled=Boolean(selectedNode) || !title || (changed && matches.length<2);
        linkNote.setAttribute('aria-pressed',String(Boolean(title && (!changed || matches.length))));
        keepNote.hidden=changed || !manualNote;
        status.hidden=!matches.length;
        status.textContent=matches.length ? [t('找到匹配的笔记','Matching notes'),...matches.map(match=>match.path)].join('\n') : '';
        current.hidden=matches.length>0;
        current.textContent=changed ? t('确认后创建新笔记，并保留当前节点的连接。','Create a new note and keep this node’s connections.')
          : manualNote?.path ?? node.path;

        const applyChoice=match=>{
          const existing=match?.node;
          const label=existing
            ? (existing.id===node.id && !selectedNode ? save : t('打开已有节点','Open existing node'))
            : changed && !match ? t('创建新笔记并保存','Create note and save') : save;
          setSubmitLabel(label,!title || (matches.length>1 && !match) || Boolean(existing?.missing));
        };
        if(matches.length>1){
          const select=selectField(choices,'matchedNote',t('选择要打开或关联的笔记','Choose a note to open or link'),
            [['',t('请选择笔记','Choose a note')],...matches.map(match=>[match.path,match.path])]);
          matchSelect=select;
          select.addEventListener('change',()=>applyChoice(matches.find(match=>match.path===select.value)));
        }
        applyChoice(matches.length===1 ? matches[0] : null);
      };
      name.addEventListener('input',()=>{
        selectedNode=null;
        update();
      });
      update();
      return name;
    },async data=>{
      const title=text(data.get('title'));
      if(!title)throw new Error(t('请输入节点名称。','Enter a node name.'));
      if(selectedNode){
        const target=this.store.index.nodes.get(selectedNode.id);
        if(!target || target.missing)throw new Error(t('匹配节点的笔记不可用。','The matching node’s note is unavailable.'));
        const view=await this.openGraph();
        view?.activate(target.id);
        return;
      }
      if(!isChanged(title)){
        await this.store.edit(node,{title,existing:manualNote});
        return;
      }
      const matches=this.editNodeMatches(title);
      const path=text(data.get('matchedNote'));
      const match=path ? matches.find(item=>item.path===path) : matches.length===1 ? matches[0] : null;
      if((path || matches.length) && !match){
        throw new Error(t('请选择要打开或关联的笔记。','Choose a note to open or link.'));
      }
      if(match?.node?.missing)throw new Error(t('匹配节点的笔记不可用。','The matching node’s note is unavailable.'));
      if(match?.node?.id===node.id){
        await this.store.edit(node,{title});
        return;
      }
      if(!match?.node)await this.store.edit(node,{title,existing:match?.file,newNote:!match});
      const view=await this.openGraph();
      view?.activate(match?.node?.id ?? node.id);
    });
  }

  nodeForm({ title='',source=null,relation='',existing=null,rebind=null,connect=false,root=false }={}) {
    const t=(zh,en)=>this.t(zh,en);
    const before=rebind;
    const availableSource=this.store.index.nodes.get(source);
    let selectedFile=existing;
    let manualChoice=existing ?? undefined;
    let needsNoteChoice=false;
    let target=null;
    let createTarget=false;
    const formTitle=rebind?t('重新绑定笔记','Rebind note'):connect?t('新建连接','New connection'):root?t('新建一级节点','Create root node'):t('新建节点','New node');
    const linkText=t('建立连接','Create connection');
    const existingTargetText=t('目标节点已存在。','The target node already exists.');
    this.modal(formTitle,connect?linkText:t('保存','Save'),(form,setSubmitLabel)=>{
      if(connect)form.className='ob-node-form';
      if(connect)element(form,'p','ob-subtle',t('起点：','Source: ')+availableSource.title);
      const name=field(form,'title',connect?t('目标节点','Target node'):t('节点名称','Node name'),before?.title??title,{
        type:'text',className:'ob-node-name',required:true,maxLength:110
      });
      if(connect)name.autocomplete='off';
      let queryRevision=0;
      const targetWarning=connect ? element(form,'p','ob-node-name-warning') : null;
      if (targetWarning) {
        targetWarning.id='ob-target-warning-' + generateId();
        targetWarning.setAttribute('aria-live','polite');
        name.setAttribute('aria-describedby',targetWarning.id);
      }
      const targets=connect ? element(form,'div','ob-connect-targets') : null;
      const targetStatus=connect ? element(form,'p','ob-subtle ob-connect-status') : null;
      targetStatus?.setAttribute('aria-live','polite');
      let validateName;
      if (!before && !connect) {
        const warning=element(form,'p','ob-node-name-warning');
        warning.id='ob-node-name-warning-' + generateId();
        warning.setAttribute('aria-live','polite');
        name.setAttribute('aria-describedby',warning.id);
        validateName=()=>{
          const duplicate=Boolean(name.value.trim()) && this.store.hasNodeName(name.value);
          const message=duplicate ? t(...DUPLICATE_NODE_NAME) : '';
          warning.hidden=!duplicate;
          warning.textContent=message;
          name.setAttribute('aria-invalid', String(duplicate));
          name.setCustomValidity(message);
        };
      }
      const binding=element(form,'div','ob-field');
      element(binding,'span','',t('关联笔记','Linked note'));
      const noteWarning=!before ? element(binding,'p','ob-note-match-warning') : null;
      noteWarning?.setAttribute('aria-live','polite');
      const selected=element(binding,'span','ob-subtle');
      const actions=element(binding,'div','ob-actions');
      let matchedNote=null;
      const pick=()=>{
        if(existingNoteButton.disabled)return;
        if(matchedNote){
          manualChoice=undefined;
          updateName();
          return;
        }
        const revision=queryRevision;
        this.filePicker(file=>{
          if(connect && revision!==queryRevision)return;
          manualChoice=selectedFile=file;
          if(!name.value.trim())name.value=file.basename;
          updateName();
        });
      };
      const newNoteButton=button(actions,t('创建新笔记','Create new note'),()=>{
        if(newNoteButton.disabled)return;
        manualChoice=selectedFile=null;
        updateName();
      },{icon:'file-plus',tooltip:false});
      const existingNoteButton=button(actions,t('关联已有笔记','Link existing note'),pick,{icon:'file-search',className:'ob-existing-note',tooltip:false});

      const updateTargets=()=>{
        const query=name.value.trim();
        const sameName=Boolean(query) && this.store.hasNodeName(query);
        createTarget=Boolean(query) && !target && !sameName;
        const alreadyRelated=target && this.store.index.hasDirectRelation(source,target.id);
        const warning=alreadyRelated ? t(...EXISTING_RELATION) : sameName && !target ? existingTargetText : '';
        targetWarning.hidden=!warning;
        targetWarning.textContent=warning;
        targets.replaceChildren();
        targetStatus.textContent=target ? target.title+' · '+target.path : '';
        targetStatus.hidden=!target;
        if(query && !target){
          this.renderNodeSuggestions(targets,this.findNodeSuggestions(query,source),node=>{
            target=node;
            name.value=node.title;
            updateName();
            name.focus();
          });
          if(sameName && !targets.children.length){
            targetStatus.hidden=false;
            targetStatus.textContent=fold(query)===fold(availableSource.title)
              ? t('节点不能连接到自己。','A node cannot link to itself.')
              : t('同名节点的笔记不可用。','The note for the matching node is unavailable.');
          }
        }
        targets.hidden=!targets.children.length;
        binding.hidden=!createTarget;
        setSubmitLabel?.(createTarget?t('创建节点并连接','Create node and connect'):linkText,!query || Boolean(warning));
      };
      const updateName=()=>{
        if(connect){
          updateTargets();
          if(!createTarget)return;
        }
        validateName?.();
        if(noteWarning){
          const matches=this.notesNamed(name.value).sort((a,b)=>compareText(a.path,b.path));
          newNoteButton.disabled=matches.length>0;
          const available=matches.filter(file=>this.canBindNote(file));
          matchedNote=available.length===1 ? available[0] : null;
          needsNoteChoice=manualChoice===undefined && available.length>1;
          selectedFile=manualChoice===undefined ? matchedNote : manualChoice;
          existingNoteButton.disabled=available.length===0 || Boolean(matchedNote && selectedFile?.path===matchedNote.path);
          noteWarning.hidden=matches.length===0;
          selected.hidden=matches.length>0 && (!selectedFile || matches.some(file=>file.path===selectedFile.path));
          const availablePaths=new Set(available.map(file=>file.path));
          const paths=matches.map(file=>file.path+(availablePaths.has(file.path) ? '' : t('（已绑定节点）',' (already linked)')));
          noteWarning.textContent=matches.length ? [t('发现同名笔记','Notes with the same name'),...paths].join('\n') : '';
        }
        selected.textContent=selectedFile?.path ?? (needsNoteChoice
          ? t('有多篇同名笔记，请选择一篇。','Several notes match. Choose one.')
          : t('保存时创建新 Markdown 笔记','Create a new Markdown note when saved'));
        const useExisting=Boolean(selectedFile) || needsNoteChoice;
        newNoteButton.setAttribute('aria-pressed',String(!useExisting && !newNoteButton.disabled));
        existingNoteButton.setAttribute('aria-pressed',String(useExisting));
      };
      name.addEventListener('input',()=>{
        if(connect){
          queryRevision++;
          target=null;
          manualChoice=undefined;
          selectedFile=null;
          matchedNote=null;
          needsNoteChoice=false;
        }
        if(manualChoice===null)manualChoice=undefined;
        updateName();
      });
      updateName();
      if(!before&&availableSource&&!availableSource.missing){
        selectField(form,'relation',t('与「'+availableSource.title+'」的关系','Relation to '+availableSource.title),
          [
            ...(!connect ? [['',t('暂不连接','No relation')]] : []),
            ['child',t('目标是当前节点的子节点','Target is a child of the source')],
            ['parent',t('目标是当前节点的父节点','Target is a parent of the source')],
            ['jump',t('建立跳转连接','Create a jump connection')]
          ],relation || (connect ? 'child' : ''));
      }
      return name;
    },async data=>{
      const kind=text(data.get('relation'));
      if(connect){
        if(!['child','parent','jump'].includes(kind))throw new Error(t('请选择关系类型。','Choose a relationship type.'));
        if(target){
          await this.store.link(source,target.id,kind);
          return;
        }
        if(this.store.hasNodeName(text(data.get('title'))))throw new Error(existingTargetText);
        if(!createTarget)throw new Error(t('请输入目标节点名称。','Enter a target node name.'));
      }
      const values={
        title:text(data.get('title')),
        root:rebind ? rebind.level==='root' : root,
        existing:selectedFile
      };
      if(needsNoteChoice)throw new Error(t('有多篇同名笔记，请先选择一篇。','Several notes match. Choose one before saving.'));
      if(!before && !selectedFile && this.notesNamed(values.title).length){
        throw new Error(t('已存在同名笔记，请绑定已有笔记或修改名称。','A note with this name already exists. Use an existing note or change the name.'));
      }
      const id=await this.store.create({...values,source,relation:kind,
        rebind:rebind?.id,description:rebind?.description,icon:rebind?.icon,color:rebind?.color});
      if(!connect){
        const view=await this.openGraph();
        view?.activate(id);
      }
    });
  }

  linkForm(id, previous=null, onSaved) {
    const source=this.store.index.nodes.get(id);
    if(!source||source.missing)return;
    const t=(zh,en)=>this.t(zh,en);
    if(!previous)return this.nodeForm({source:id,connect:true});
    let target=previous.target;
    this.modal(t('编辑关系','Edit relationship'),t('保存关系','Save relationship'),form=>{
      element(form,'p','ob-subtle',t('焦点：','Source: ')+source.title);
      const pick=element(form,'div','ob-field');
      const label=element(pick,'span');
      const update=()=>{label.textContent=this.store.index.nodes.get(target)?.title??t('请选择目标节点','Choose a target node');};
      update();
      const focus=button(pick,t('查找目标节点','Find target node'),()=>{
        const nodes=[...this.store.index.nodes.values()].filter(node=>!node.missing&&node.id!==id);
        if(!nodes.length){new Notice(t('请先创建另一个节点。','Create another node first.'));return;}
        new Picker(this,nodes,node=>node.title+' · '+node.path,node=>{target=node.id;update();},t('搜索目标节点…','Search target nodes…')).open();
      },{icon:'search'});
      selectField(form,'kind',t('关系类型','Relationship type'),
        [['child',t('目标是子节点','Target is a child')],['parent',t('目标是父节点','Target is a parent')],['jump',t('跳转节点 · 左侧','Jump · left')]],
        previous?.kind??'child');
      element(form,'p','ob-subtle',t('同级节点由共同父节点自动计算，并显示在右侧。','Siblings are derived from shared parents and shown on the right.'));
      return focus;
    },async data=>{
      if(!target)throw new Error(t('请选择目标节点。','Choose a target node.'));
      await this.store.link(id,target,text(data.get('kind')),previous);
      if(onSaved)queueMicrotask(onSaved);
    });
  }

  relationsForm(id) {
    const source=this.store.index.nodes.get(id);
    if(!source)return;
    const t=(zh,en)=>this.t(zh,en);
    const modal=new Modal(this.app);
    modal.setTitle(t('管理关系 · ','Manage relationships · ')+source.title);
    modal.onOpen=()=>{
      const {parent,child,jump,sibling}=this.store.index.relatives(id);
      const root=modal.contentEl;
      root.classList.add('ob-form');
      for(const [kind,items] of Object.entries({parent,child,jump,sibling})){
        element(root,'h4','',t(...LABELS[kind])+' · '+items.length);
        for(const entry of items){
          const node=entry.node??entry;
          const row=element(root,'div','ob-relation-row');
          const label=element(row,'span','',node.title);
          if(kind==='sibling'){
            label.title=t('共同父节点：','Shared parents: ')+entry.parents.map(item=>item.title).join('、');
            element(label,'small','ob-subtle',label.title);
          }else{
            if(!node.missing)button(row,t('编辑关系','Edit relationship'),()=>{
              modal.close();
              this.linkForm(id,{target:node.id,kind},()=>this.relationsForm(id));
            },{icon:'pencil',iconOnly:true});
            button(row,t('解除关系','Disconnect'),()=>this.run(this.store.unlink(id,node.id,kind).then(()=>{
              modal.close();this.relationsForm(id);
            })),{icon:'unlink',iconOnly:true});
          }
        }
      }
      button(root,t('新建连接','New connection'),()=>{modal.close();this.linkForm(id);},{icon:'plus'});
    };
    modal.open();
  }

  deleteForm(node) {
    const t=(zh,en)=>this.t(zh,en);
    this.modal(t('删除节点','Delete node'),t('确认删除','Delete node'),form=>{
      element(form,'p','',node.title);
      return selectField(form,'action',t('处理方式','Action'),[
        ['keep',t('删除节点与关系，保留笔记','Remove node and relationships, keep the note')],
        ...(!node.missing?[['trash',t('同时将笔记移入 Obsidian 回收站','Also move the note to Obsidian trash')]]:[])
      ],'keep');
    },data=>this.store.remove(node.id,data.get('action')==='trash'));
  }

  rebuild() {
    return this.run(this.store.scan().then(()=>new Notice(this.t('图谱索引已更新。','Graph index updated.'))));
  }

  confirmClear() {
    this.modal(this.t('清空访问历史','Clear recent nodes'),this.t('清空','Clear'),form=>{
      element(form,'p','ob-subtle',this.t('确认清空最近访问记录。','Clear the list of recently opened nodes.'));
    },()=>{this.history=[];this.persist();for(const view of this.views())if(view.isGraphOpen)view.render();});
  }

  resetForm() {
    const t=(zh,en)=>this.t(zh,en);
    this.modal(t('重置视图数据','Reset view data'),t('重置','Reset'),form=>{
      element(form,'p','ob-subtle',t('恢复默认设置并清空访问记录。','Restore defaults and clear recent history.'));
    },()=>{
      this.settings={...DEFAULTS};this.history=[];this.lastFocus='';this.lastFocusAt=0;
      this.persist();this.refreshViews();
    });
  }

  healthForm() {
    const t=(zh,en)=>this.t(zh,en);
    const {dangling,duplicates,nodes}=this.store.index;
    this.modal(t('图谱数据健康检查','Graph data health'),dangling.length?t('清理悬挂链接','Clean dangling links'):t('完成','Done'),form=>{
      element(form,'p','',t('悬挂链接：','Dangling links: ')+dangling.length);
      for(const edge of dangling.slice(0,60))element(form,'p','ob-subtle',nodes.get(edge.from)?.path+' → '+edge.to+' · '+edge.field);
      element(form,'p','',t('重复 ID：','Duplicate IDs: ')+duplicates.length);
      for(const paths of duplicates.slice(0,30))element(form,'p','ob-subtle',paths.join(' · '));
      if(dangling.length>60||duplicates.length>30)element(form,'p','ob-subtle',t('列表仅展示部分条目。','Only a subset of items is shown.'));
    },()=>dangling.length?this.store.cleanDangling():undefined);
  }

  exportGraph() {
    return this.run((async()=>{
      const nodes=[...this.store.index.nodes.values()].filter(node=>!node.missing).map(({id,title,path,level,children,jumps,order,color,icon,description})=>({
        id,title,path,level,children,jumps,order,color,icon,description
      }));
      const root=this.app.vault.getRoot().path;
      const name='ob-brain-graph-' + new Date().toISOString().replace(/[:.]/g,'-') + '.json';
      const path=normalizePath((root==='/'?'':root+'/')+name);
      await this.app.vault.create(path,JSON.stringify({format:'ob-brain',version:1,nodes},null,2)+'\n');
      new Notice(this.t('已导出：','Exported: ')+path,6000);
    })());
  }

  importForm() {
    const t=(zh,en)=>this.t(zh,en);
    this.modal(t('导入图谱 JSON','Import graph JSON'),t('导入','Import'),form=>{
      element(form,'p','ob-subtle',t('仅写入目标笔记的节点属性。已有节点必须与导入 ID 一致；同 ID 的图谱属性会更新。','Only graph metadata is written. Existing nodes must use the same ID; graph fields with matching IDs will be updated.'));
      const input=field(form,'graph',t('选择 JSON 文件','Choose a JSON file'),'',{type:'file',accept:'.json,application/json',required:true});
      return input;
    },async data=>{
      const file=data.get('graph');
      if(!file?.size||file.size>10*1024*1024)throw new Error(t('请选择不超过 10 MB 的图谱 JSON。','Choose a graph JSON file up to 10 MB.'));
      await this.store.importGraph(JSON.parse(await file.text()));
      new Notice(t('图谱已导入。','Graph imported.'));
    });
  }
}

module.exports = OBBrain;
