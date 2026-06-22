#!/usr/bin/env node
// Convert mono WAV to stereo WAV by duplicating the single channel
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: mono2stereo.js <input.wav> <output.wav>');
  process.exit(1);
}

const data = fs.readFileSync(inputPath);
if (data.length < 44) {
  console.error('Not a valid WAV file (too small)');
  process.exit(1);
}

// Parse WAV header
const riff = data.toString('ascii', 0, 4);
if (riff !== 'RIFF') {
  console.error('Not a RIFF file');
  process.exit(1);
}
const wave = data.toString('ascii', 8, 12);
if (wave !== 'WAVE') {
  console.error('Not a WAVE file');
  process.exit(1);
}

// Find fmt chunk
let offset = 12;
let foundFmt = false;
let channels = 1;
let sampleRate = 44100;
let bitsPerSample = 16;
let dataOffset = 0;
let dataSize = 0;

while (offset < data.length - 8) {
  const chunkId = data.toString('ascii', offset, offset + 4);
  const chunkSize = data.readUInt32LE(offset + 4);
  if (chunkId === 'fmt ') {
    foundFmt = true;
    const audioFormat = data.readUInt16LE(offset + 8);
    channels = data.readUInt16LE(offset + 10);
    sampleRate = data.readUInt32LE(offset + 12);
    bitsPerSample = data.readUInt16LE(offset + 22);
    if (audioFormat !== 1) {
      console.error('Not PCM format');
      process.exit(1);
    }
  } else if (chunkId === 'data') {
    dataOffset = offset + 8;
    dataSize = chunkSize;
    break;
  }
  offset += 8 + chunkSize + (chunkSize % 2);
}

if (!foundFmt || dataOffset === 0) {
  console.error('Could not parse WAV');
  process.exit(1);
}

if (channels !== 1) {
  console.error('Input is not mono (channels=' + channels + ')');
  process.exit(1);
}

const bytesPerSample = bitsPerSample / 8;
const pcmData = data.slice(dataOffset, dataOffset + dataSize);

// Create stereo WAV by duplicating each sample
const stereoData = Buffer.alloc(pcmData.length * 2);
for (let i = 0; i < pcmData.length; i += bytesPerSample) {
  const left = pcmData.slice(i, i + bytesPerSample);
  stereoData.writeUInt16LE(left.readUInt16LE(0), i * 2);       // Left
  stereoData.writeUInt16LE(left.readUInt16LE(0), i * 2 + 2);   // Right
}

// Build stereo WAV header
const byteRate = sampleRate * 2 * (bitsPerSample / 8);
const blockAlign = 2 * (bitsPerSample / 8);
const header = Buffer.alloc(44);
header.write('RIFF', 0, 'ascii');
header.writeUInt32LE(36 + stereoData.length, 4);
header.write('WAVE', 8, 'ascii');
header.write('fmt ', 12, 'ascii');
header.writeUInt32LE(16, 16);  // chunk size
header.writeUInt16LE(1, 20);   // PCM
header.writeUInt16LE(2, 22);   // 2 channels
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(byteRate, 28);
header.writeUInt16LE(blockAlign, 32);
header.writeUInt16LE(bitsPerSample, 34);
header.write('data', 36, 'ascii');
header.writeUInt32LE(stereoData.length, 40);

fs.writeFileSync(outputPath, Buffer.concat([header, stereoData]));
console.log('Converted ' + channels + 'ch ' + sampleRate + 'Hz ' + bitsPerSample + 'bit -> 2ch ' + sampleRate + 'Hz ' + bitsPerSample + 'bit');
