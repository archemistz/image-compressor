import sharp from 'sharp';

const inputFile = 'input.jpg';
const outputFile = 'output.jpg';

sharp(inputFile)
  .jpeg({ quality: 70 })
  .toFile(outputFile)
  .then(() => {
    console.log('Done! Check output.jpg');
  });

