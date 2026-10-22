export async function openStore(name = 'SpeedRead') {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('books', { keyPath: 'id' }); req.result.createObjectStore('settings'); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Закройте другие вкладки SpeedRead и повторите.'));
  });
  function transact(names, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode); let result;
      try { result = action(tx); } catch (e) { tx.abort(); reject(e); return; }
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Запись отменена.'));
    });
  }
  return {
    state: () => transact(['settings'], 'readonly', tx => tx.objectStore('settings').get('main')),
    books: () => transact(['books'], 'readonly', tx => tx.objectStore('books').getAll()),
    save: state => transact(['settings'], 'readwrite', tx => tx.objectStore('settings').put(state, 'main')),
    put: (books, state) => transact(['books', 'settings'], 'readwrite', tx => {
      for (const book of books) tx.objectStore('books').put(book);
      tx.objectStore('settings').put(state, 'main');
    })
  };
}
