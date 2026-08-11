import sharp from 'sharp';

try {
  const metadata = await sharp('input.heic').metadata();
  console.log('Success! Format detected as:', metadata.format);
  console.log('Width:', metadata.width, 'Height:', metadata.height);
} catch (err) {
  console.log('FAILED to read HEIC file.');
  console.log('Error message:', err.message);
}
