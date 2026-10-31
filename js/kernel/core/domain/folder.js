/**
 * Folders, as IndexedDB has stored them since 1.4.0. A root folder's `parentId` is null.
 */

/**
 * @typedef {object} FolderFields
 * @property {string} name
 * @property {string | null} parentId
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string | null} color
 * @property {boolean} collapsed
 */

/** @typedef {{id: string} & Partial<FolderFields> & Record<string, unknown>} FolderRecord */

/**
 * A new folder, field for field the one Storage.createFolder writes.
 * @param {{id: string, name: string, parentId: string | null, now: number}} fields
 * @returns {FolderRecord & FolderFields}
 */
export function newFolderRecord({ id, name, parentId, now }) {
  return { id, name, parentId, createdAt: now, updatedAt: now, color: null, collapsed: false };
}

/**
 * Whether giving `folderId` the parent `parentId` would put the folder inside itself: the
 * parent is the folder or one of its descendants. `folders` is the committed list. A parent
 * chain that already loops counts too, since a folder moved into it could never be reached
 * from the root.
 * @param {FolderRecord[]} folders
 * @param {string} folderId
 * @param {string | null} parentId
 * @returns {boolean}
 */
export function createsCycle(folders, folderId, parentId) {
  /** @type {Map<string, string | null>} */
  const parents = new Map(folders.map(folder => [folder.id, folder.parentId ?? null]));
  const seen = new Set();
  for (let current = parentId; current !== null; current = parents.get(current) ?? null) {
    if (current === folderId || seen.has(current)) return true;
    seen.add(current);
  }
  return false;
}

/**
 * The folder and every folder inside it, from the committed list, in the order
 * Storage.deleteFolder walks them: the folder, then each one's children, level by level. A
 * parent chain that loops is walked once.
 * @param {FolderRecord[]} folders
 * @param {string} folderId
 * @returns {string[]}
 */
export function folderSubtree(folders, folderId) {
  const subtree = [folderId];
  for (let i = 0; i < subtree.length; i++) {
    for (const folder of folders) {
      if ((folder.parentId ?? null) === subtree[i] && !subtree.includes(folder.id)) subtree.push(folder.id);
    }
  }
  return subtree;
}
