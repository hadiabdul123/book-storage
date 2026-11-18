export function wavFixture() {
  const dataLength = 8000 * 3 * 2;
  const blob = Buffer.alloc(44 + dataLength);
  blob.write("RIFF", 0); blob.writeUInt32LE(36 + dataLength, 4); blob.write("WAVEfmt ", 8);
  blob.writeUInt32LE(16, 16); blob.writeUInt16LE(1, 20); blob.writeUInt16LE(1, 22);
  blob.writeUInt32LE(8000, 24); blob.writeUInt32LE(16000, 28); blob.writeUInt16LE(2, 32); blob.writeUInt16LE(16, 34);
  blob.write("data", 36); blob.writeUInt32LE(dataLength, 40);
  return blob;
}
