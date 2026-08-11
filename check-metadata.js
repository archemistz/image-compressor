import sharp from 'sharp';

const originalMeta = await sharp('input.jpg').metadata();
const compressedMeta = await sharp('output.jpg').metadata();

console.log('--- Original ---');
console.log('Has EXIF:', !!originalMeta.exif);
console.log('Has ICC color profile:', !!originalMeta.icc);
console.log('Orientation:', originalMeta.orientation);

console.log('--- Compressed ---');
console.log('Has EXIF:', !!compressedMeta.exif);
console.log('Has ICC color profile:', !!compressedMeta.icc);
console.log('Orientation:', compressedMeta.orientation);

