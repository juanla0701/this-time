// storage.js
// Room을 대체하는 저장소. IndexedDB를 사용한다 (localStorage는 사진/자료가
// 많아지면 용량 한계가 있어서 제외).
//
// 오브젝트 스토어 (v1부터 있던 것):
//   subjects, units, materials, materialImages, summaries,
//   questions, testSessions, testAnswers, wrongAnswers
// v2에서 추가:
//   wordItems  - 단순 단어 암기 항목 (term / definition / sourceExcerpt / studyLevel ...)
//   points     - 내용 암기의 "암기 포인트" (단원 자료에서 추출한 핵심 내용 1개 = 1레코드)
//
// v1 → v2 마이그레이션은 기존 데이터를 지우지 않는다 (아래 migrateV1toV2 참고).
window.Storage = (function () {
  const DB_NAME = "exam_memo_db";
  const DB_VERSION = 2;
  let dbPromise = null;

  function ensureStore(db, tx, name, indexes) {
    let store;
    if (!db.objectStoreNames.contains(name)) {
      store = db.createObjectStore(name, { keyPath: "id" });
    } else {
      store = tx.objectStore(name);
    }
    for (const idx of indexes || []) {
      if (!store.indexNames.contains(idx)) store.createIndex(idx, idx);
    }
    return store;
  }

  /**
   * v1 자료 레코드를 v2 형태로 보강한다. 기존 값은 절대 지우지 않는다.
   *  - v1의 material.rawText는 "사용자 수정 후 최종 텍스트"였으므로 finalText로 복사
   *  - 사진 자료의 rawText는 이미지별 원본 OCR(rawOcrText)을 합친 값으로 채움
   *  - imageIds, materialType, studyMode(기존 자료는 모두 '내용 암기') 추가
   */
  function migrateV1toV2(tx) {
    const imagesByMaterial = {};
    const imgReq = tx.objectStore("materialImages").openCursor();
    imgReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const img = cursor.value;
        (imagesByMaterial[img.materialId] = imagesByMaterial[img.materialId] || []).push(img);
        cursor.continue();
        return;
      }
      // 이미지 수집이 끝나면 자료를 갱신
      const matReq = tx.objectStore("materials").openCursor();
      matReq.onsuccess = (ev) => {
        const c = ev.target.result;
        if (!c) return;
        const m = c.value;
        const imgs = (imagesByMaterial[m.id] || []).sort((a, b) => a.orderIndex - b.orderIndex);
        if (m.finalText === undefined) {
          const final = m.rawText || "";
          m.finalText = final;
          if (m.type === "PHOTO" && imgs.length) {
            const raw = imgs.map((i) => i.rawOcrText || "").join("\n\n");
            m.rawText = raw.trim() ? raw : final;
          }
        }
        if (!m.imageIds) m.imageIds = imgs.map((i) => i.id);
        if (!m.materialType) m.materialType = m.type || "TEXT";
        if (!m.studyMode) m.studyMode = "content";
        c.update(m);
        c.continue();
      };
    };
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        const tx = event.target.transaction;
        const oldVersion = event.oldVersion;

        ensureStore(db, tx, "subjects", []);
        ensureStore(db, tx, "units", ["subjectId"]);
        ensureStore(db, tx, "materials", ["unitId", "subjectId"]);
        // 사진 자체(Blob)까지 이 스토어에 함께 저장한다 (Base64보다 Blob 우선).
        ensureStore(db, tx, "materialImages", ["materialId"]);
        ensureStore(db, tx, "summaries", ["unitId"]);
        ensureStore(db, tx, "questions", ["unitId", "sessionId", "subjectId"]);
        ensureStore(db, tx, "testSessions", ["unitId", "subjectId"]);
        ensureStore(db, tx, "testAnswers", ["sessionId"]);
        ensureStore(db, tx, "wrongAnswers", ["questionId", "targetId", "subjectId"]);
        // v2 신규
        ensureStore(db, tx, "wordItems", ["subjectId", "materialId"]);
        ensureStore(db, tx, "points", ["unitId", "subjectId", "materialId"]);

        if (oldVersion >= 1 && oldVersion < 2) {
          migrateV1toV2(tx);
        }
      };

      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => reject(event.target.error);
      req.onblocked = () => console.warn("다른 탭에서 앱이 열려 있어 DB 업그레이드가 대기 중입니다.");
    });
    return dbPromise;
  }

  async function put(storeName, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 여러 레코드를 한 트랜잭션으로 저장 (시험 문제 수십 개 저장 등). */
  async function putMany(storeName, values) {
    if (!values.length) return values;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const v of values) store.put(v);
      tx.oncomplete = () => resolve(values);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function get(storeName, id) {
    if (id === undefined || id === null) return null;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllByIndex(storeName, indexName, value) {
    if (value === undefined || value === null) return [];
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(storeName, id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function removeMany(storeName, ids) {
    if (!ids.length) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Room의 FK CASCADE에 대응: 인덱스로 찾은 하위 로우들을 전부 지운다. */
  async function removeAllByIndex(storeName, indexName, value) {
    const items = await getAllByIndex(storeName, indexName, value);
    await removeMany(
      storeName,
      items.map((i) => i.id)
    );
    return items;
  }

  return { openDb, put, putMany, get, getAll, getAllByIndex, remove, removeMany, removeAllByIndex };
})();
