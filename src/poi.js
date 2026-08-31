import { db, newId } from './db.js';

export async function createPoi({ name, category, notes, lat, lon, photoFiles }) {
  const photos = [];
  if (photoFiles && photoFiles.length) {
    for (const file of photoFiles) {
      const blob = await compressImage(file);
      photos.push({ blob, name: file.name || 'photo.jpg' });
    }
  }
  const poi = {
    id: newId(),
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

export async function deletePoi(id) {
  await db.delete('pois', id);
}

export async function getAllPois() {
  return db.all('pois');
}

// A page you glance at doesn't need more than this - 800px is sharp at
// full-screen on a phone and only mildly softer stretched wide on a big
// desktop monitor, at a fraction of the size. Original photo stays
// untouched on the phone regardless.
function compressImage(file, maxWidth = 800, quality = 0.78) {
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
