import { db, newId } from './db.js';

export async function createPoi({ tripId, name, category, notes, lat, lon, photoFiles }) {
  const photos = [];
  if (photoFiles && photoFiles.length) {
    for (const file of photoFiles) {
      const blob = await compressImage(file);
      photos.push(blob);
    }
  }
  const poi = {
    id: newId(),
    tripId,
    name,
    category,
    notes: notes || '',
    lat, lon,
    photos,
    createdAt: Date.now(),
  };
  await db.put('pois', poi);
  return poi;
}

export async function updatePoi(poi) {
  await db.put('pois', poi);
}

export async function deletePoi(id) {
  await db.delete('pois', id);
}

export async function poisForTrip(tripId) {
  return db.byIndex('pois', 'tripId', tripId);
}

export async function addPhotosToPoi(poi, photoFiles) {
  for (const file of photoFiles) {
    const blob = await compressImage(file);
    poi.photos.push(blob);
  }
  await db.put('pois', poi);
  return poi;
}

function compressImage(file, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
