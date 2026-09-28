// imageStorage.js
// 사진 자료의 실제 이미지(Blob)를 다루는 모듈. IndexedDB가 Blob을 직접 저장할 수 있어서
// Base64 변환 없이 File/Blob 그대로 보관한다.
window.ImageStorage = (function () {
  /**
   * OCR까지 끝난 이미지들을 한 번에 저장한다.
   * images: [{ blob: Blob, rawOcrText: string|null, editedText: string,
   *            (v4, 선택) processedBlob, preprocess, layout, ocrRegions, structure }]
   *
   * 레코드 (v4에서 추가된 필드는 모두 선택 — 예전 레코드는 없어도 그대로 동작):
   *   blob          원본 사진 (절대 바꾸지 않음 = image)
   *   processedBlob 전처리 이미지 (조명 평탄화·기울기·원근 보정 = processedImage)
   *   preprocess    { width, height, deskewAngle, perspective, layoutFound, timings }
   *   layout        { found, table, regions:[{kind,index,x,y,w,h}] }  (전처리 이미지 좌표)
   *   ocrRegions    영역별 변형(A/B/C/원본) OCR 결과와 합의 결과 (디버그·재분석용)
   *   structureJson 이 사진 한 쪽의 문서 구조 (DocStructure 쪽 구조)
   */
  async function saveImages(materialId, images) {
    const now = Utils.now();
    const records = images.map((img, i) => ({
      id: Utils.generateId(),
      materialId,
      blob: img.blob,
      rawOcrText: img.rawOcrText ?? null, // OCR이 처음 인식한 원본 (수정하지 않음)
      ocrText: img.editedText ?? "", // 사용자가 확인·수정한 최종본
      structureJson: img.structure || null,
      processedBlob: img.processedBlob || null,
      preprocess: img.preprocess || null,
      layout: img.layout || null,
      ocrRegions: img.ocrRegions || null,
      orderIndex: i,
      createdAt: now,
    }));
    await Storage.putMany("materialImages", records);
    return records;
  }

  async function getImages(materialId) {
    const items = await Storage.getAllByIndex("materialImages", "materialId", materialId);
    return items.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  async function removeImages(materialId) {
    return Storage.removeAllByIndex("materialImages", "materialId", materialId);
  }

  function blobToObjectUrl(blob) {
    return URL.createObjectURL(blob);
  }

  return { saveImages, getImages, removeImages, blobToObjectUrl };
})();
