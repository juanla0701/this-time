// subjects.js
// 과목 (예: 대한민국 역사, 해부학, 간호학, 법학, 영어 단어 ...). 이름은 자유 텍스트.
window.Subjects = (function () {
  async function list() {
    const items = await Storage.getAll("subjects");
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function create(name) {
    const now = Utils.now();
    const subject = {
      id: Utils.generateId(),
      name: name.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await Storage.put("subjects", subject);
    return subject;
  }

  async function get(id) {
    return Storage.get("subjects", id);
  }

  async function rename(id, newName) {
    const subject = await get(id);
    if (!subject) return;
    subject.name = newName.trim();
    subject.updatedAt = Utils.now();
    await Storage.put("subjects", subject);
  }

  /**
   * 과목 삭제: 연결된 단원·자료·사진·단어 항목·암기 포인트·문제·시험 기록·오답 기록을
   * 모두 함께 지운다 (다른 과목 데이터는 subjectId가 다르므로 건드리지 않는다).
   */
  async function remove(id) {
    const units = await Storage.getAllByIndex("units", "subjectId", id);
    for (const unit of units) {
      await Units.remove(unit.id);
    }
    // 단어 암기용 자료 등 단원에 속하지 않은 자료
    const materials = await Storage.getAllByIndex("materials", "subjectId", id);
    for (const m of materials) {
      await Materials.remove(m.id, { skipRefresh: true });
    }
    await Storage.removeAllByIndex("wordItems", "subjectId", id);
    await Storage.removeAllByIndex("points", "subjectId", id);
    await Quiz.removeSessionsBy("subjectId", id);
    await Storage.removeAllByIndex("questions", "subjectId", id);
    await Storage.removeAllByIndex("wrongAnswers", "subjectId", id);
    await Storage.remove("subjects", id);
  }

  return { list, create, get, rename, remove };
})();
