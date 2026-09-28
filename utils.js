// utils.js
// 여러 파일에서 공통으로 쓰는 작은 헬퍼 모음.
window.Utils = (function () {
  function generateId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // 구형 브라우저 대비 폴백
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function now() {
    return Date.now();
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function truncate(str, n) {
    if (!str) return "";
    return str.length > n ? str.slice(0, n) + "…" : str;
  }

  function formatDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  /** "방금 전", "3분 전", "2일 전" 같은 상대 시간. */
  function timeAgo(ts) {
    if (!ts) return "";
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금 전";
    if (min < 60) return `${min}분 전`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}시간 전`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day}일 전`;
    return formatDate(ts).slice(0, 12);
  }

  /** Fisher–Yates 셔플. 원본 배열은 건드리지 않고 새 배열을 돌려준다. */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /** 가중치 랜덤 선택. items와 weights 길이가 같아야 한다. */
  function weightedPick(items, weights) {
    const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (total <= 0) return pickRandom(items);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /**
   * 채점/근거 대조용 정규화: 공백·구두점·기호를 모두 제거하고 소문자로.
   * 예) "이 성계." → "이성계"
   */
  function normalizeText(str) {
    return String(str ?? "")
      .toLowerCase()
      .replace(/[\s ]+/g, "")
      .replace(/[.,!?;:'"“”‘’`~·•…()\[\]{}<>《》「」『』\-_=+*/\\|]/g, "");
  }

  /** 짧은 문자열 해시 (자료 변경 감지용, 보안 목적 아님). */
  function hashString(str) {
    let h = 5381;
    const s = String(str ?? "");
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + ":" + s.length;
  }

  function average(nums) {
    if (!nums.length) return 0;
    return nums.reduce((s, n) => s + n, 0) / nums.length;
  }

  return {
    generateId,
    now,
    escapeHtml,
    truncate,
    formatDate,
    timeAgo,
    shuffle,
    pickRandom,
    weightedPick,
    clamp,
    normalizeText,
    hashString,
    average,
  };
})();
