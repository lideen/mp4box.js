import {
  createFile,
  DataStream,
  Endianness,
  MP4BoxBuffer,
  MultiBufferStream,
  type MoovStartInfo,
  type Sample,
} from '../entries/all';
import { getFilePath, getFileRange, loadAndGetInfo } from './common';

async function collectTestSamples() {
  const { testFile } = getFilePath('isobmff', '17_negative_ctso.mp4');
  const { mp4 } = await loadAndGetInfo(testFile, true, true);

  // Extract samples from the MP4 file
  mp4.setExtractionOptions(1, undefined, { nbSamples: 100 });

  // Create a new promise to handle the extraction
  const samples = await new Promise<Array<Sample>>(resolve => {
    // Set up the onSamples callback to resolve the promise
    mp4.onSamples = (id, user, extracted) => resolve(extracted);

    // Start the extraction process
    mp4.start();
  });

  // Extract the decoder configuration
  const avcC = new MultiBufferStream();
  avcC.endianness = Endianness.BIG_ENDIAN;
  mp4.getBox('avcC').write(avcC);

  // Wrap it as an ArrayBuffer
  const decoderConfig = new ArrayBuffer(avcC.buffer.byteLength - 8);
  new Uint8Array(decoderConfig).set(new Uint8Array(avcC.buffer, 8));

  return { samples, decoderConfig };
}

describe('File Creation', () => {
  it('should create a valid file', async () => {
    // Get test samples
    const { samples, decoderConfig } = await collectTestSamples();

    // Create a new MP4 file
    const mp4 = createFile();

    // Create a new track
    const track = mp4.addTrack({
      timescale: 100,
      avcDecoderConfigRecord: decoderConfig,
      width: 320,
      height: 180,
    });

    // Add samples to the track
    for (const sample of samples) {
      mp4.addSample(track, sample.data, {
        duration: sample.duration,
        cts: sample.cts,
        dts: sample.dts,
        is_sync: sample.is_sync,
      });
    }

    // Output the file to a buffer
    const ds = new DataStream();
    ds.endianness = Endianness.BIG_ENDIAN;
    mp4.write(ds);

    // Create a new MP4 file from the output stream
    const newMP4 = createFile(true);
    newMP4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ds.buffer, 0), true);
    newMP4.flush();

    // Assertions
    expect(newMP4.getInfo().tracks.length).toBe(1);
    expect(newMP4.getTrackById(1).samples.length).toBe(100);
    expect(newMP4.getBoxes('moof', false).length).toBe(100);
    expect(ds.buffer.byteLength).toBe(40_591);
  });

  it('should create fragments with 1 sample each', async () => {
    const { samples, decoderConfig } = await collectTestSamples();

    const mp4 = createFile();
    const track = mp4.addTrack({
      timescale: 100,
      avcDecoderConfigRecord: decoderConfig,
      width: 320,
      height: 180,
    });

    mp4.setSegmentOptions(track, undefined, {
      nbSamplesPerFragment: 1,
      rapAlignement: false,
    });

    const fragmentBuffers: Array<ArrayBuffer> = [];
    mp4.onSegment = (id, user, buffer) => {
      fragmentBuffers.push(buffer);
    };

    const { buffer: initBuffer } = mp4.initializeSegmentation();
    mp4.start();

    for (const sample of samples) {
      mp4.addSample(track, sample.data, {
        duration: sample.duration,
        cts: sample.cts,
        dts: sample.dts,
        is_sync: sample.is_sync,
      });
    }
    mp4.flush();

    expect(initBuffer.byteLength).toBeGreaterThan(0);
    expect(fragmentBuffers.length).toBe(samples.length);
  });

  it('should not fail with incomplete mdat', async () => {
    const { testFile } = getFilePath('isobmff', '17_negative_ctso.mp4');
    const mp4 = createFile(false);

    // Load only until the first sample
    const mdatOffset = 17_105 + 8; // ftyp + moov + mdat header
    const firstSampleSize = 2_895; // mdat header + first sample size
    await getFileRange(testFile, data => mp4.appendBuffer(data), 0, mdatOffset + firstSampleSize);

    // Setup for extraction
    mp4.setExtractionOptions(1, undefined, { nbSamples: 1 });
    let sampleCount = 0;
    mp4.onSamples = (id, user, extracted) => (sampleCount += extracted.length);
    mp4.start();

    // Check if the sample is extracted correctly
    expect(sampleCount).toBe(0);
  });
});

describe('given a moov box split across buffers', () => {
  describe('when its header is appended', () => {
    it('should report its start and size before the box is complete', () => {
      const mp4 = createFile();
      const starts: Array<MoovStartInfo> = [];
      mp4.onMoovStart = info => starts.push(info);

      const firstBuffer = new ArrayBuffer(16);
      const firstView = new DataView(firstBuffer);
      firstView.setUint32(0, 8);
      new Uint8Array(firstBuffer, 4, 4).set(new TextEncoder().encode('free'));
      firstView.setUint32(8, 16);
      new Uint8Array(firstBuffer, 12, 4).set(new TextEncoder().encode('moov'));

      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(firstBuffer, 0));

      expect(starts).toEqual([{ start: 8, size: 16 }]);
      expect(mp4.getBox('moov')).toBeUndefined();

      const secondBuffer = new ArrayBuffer(8);
      const secondView = new DataView(secondBuffer);
      secondView.setUint32(0, 8);
      new Uint8Array(secondBuffer, 4, 4).set(new TextEncoder().encode('free'));

      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(secondBuffer, 16));

      expect(starts).toHaveLength(1);
    });
  });
});

describe('given a complete moov box', () => {
  describe('when it is appended', () => {
    it('should report its start and size', () => {
      const mp4 = createFile();
      const starts: Array<MoovStartInfo> = [];
      mp4.onMoovStart = info => starts.push(info);

      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setUint32(0, 8);
      new Uint8Array(buffer, 4, 4).set(new TextEncoder().encode('moov'));

      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));

      expect(starts).toEqual([{ start: 0, size: 8 }]);
      expect(mp4.getBox('moov')).toBeDefined();
    });
  });
});
