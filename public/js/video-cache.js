// 浏览器不会保存本地 File 路径，用 IndexedDB 保存一份仅供本机课程恢复的视频副本。
const DB_NAME = 'shadow-english-media';
const STORE = 'videos';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('当前浏览器不支持本地视频缓存'));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开视频缓存'));
  });
}

const keyOf = (name) => `video:${String(name || '').toLowerCase()}`;

export async function saveVideoFile(name, file) {
  if (!name || !file) return false;
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(file, keyOf(name));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('视频缓存失败'));
      tx.onabort = () => reject(tx.error || new Error('视频缓存被取消'));
    });
    await navigator.storage?.persist?.().catch?.(() => {});
    return true;
  } finally {
    db.close();
  }
}

export async function loadVideoFile(name) {
  if (!name) return null;
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(keyOf(name));
      req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => reject(req.error || new Error('读取视频缓存失败'));
    });
  } finally {
    db.close();
  }
}

export async function removeVideoFile(name) {
  if (!name) return;
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(keyOf(name));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('清理视频缓存失败'));
    });
  } finally {
    db.close();
  }
}
