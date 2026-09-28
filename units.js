// units.js
// 내용 암기의 단원 (예: 1단원 뼈, 2단원 근육, 삼국시대 ...). 이름은 자유 텍스트.
// 단원마다 자료·암기 포인트·요약·시험 기록·오답·학습률이 독립적으로 저장된다
// (모든 하위 레코드가 unitId로 묶이므로 다른 단원과 섞이지 않는다).
window.Units = (function () {
  async function listBySubject(subjectId) {
    const items = await Storage.getAllByIndex("units", "subjectId", subjectId);
    return items.sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt);
  }

  async function create(subjectId, name) {
    const existing = await listBySubject(subjectId);
    const now = Utils.now();
    const unit = {
      id: Utils.generateId(),
      subjectId,
      name: name.trim(),
      orderIndex: existing.length ? Math.max(...existing.map((u) => u.orderIndex || 0)) + 1 : 0,
      createdAt: now,
      updatedAt: now,
    };
    await Storage.put("units", unit);
    return unit;
  }

  async function get(id) {
    return Storage.get("units", id);
  }

  async function rename(id, newName) {
    const unit = await get(id);
    if (!unit || !newName.trim()) return;
    unit.name = newName.trim();
    unit.updatedAt = Utils.now();
    await Storage.put("units", unit);
  }

  /** 단원 삭제 시 그 단원의 자료(사진 포함)·포인트·요약·시험·오답을 모두 정리한다. */
  async function remove(unitId) {
    const materials = await Storage.getAllByIndex("materials", "unitId", unitId);
    for (const material of materials) {
      await Materials.remove(material.id, { skipRefresh: true });
    }
    await Storage.removeAllByIndex("points", "unitId", unitId);
    await Storage.removeAllByIndex("summaries", "unitId", unitId);
    await Quiz.removeSessionsBy("unitId", unitId);

    // v1에서 만들어진(세션 없이 단원에 붙은) 문제와 그 오답 기록
    const legacyQuestions = await Storage.removeAllByIndex("questions", "unitId", unitId);
    for (const q of legacyQuestions) {
      await Storage.removeAllByIndex("wrongAnswers", "questionId", q.id);
    }
    const unit = await get(unitId);
    if (unit) {
      const wrong = await Storage.getAllByIndex("wrongAnswers", "subjectId", unit.subjectId);
      await Storage.removeMany(
        "wrongAnswers",
        wrong.filter((w) => w.unitId === unitId).map((w) => w.id)
      );
    }
    await Storage.remove("units", unitId);
  }

  return { listBySubject, create, get, rename, remove };
})();
