// ── DK Rap Frame Extractor ─────────────────────────────────────
// Extracts video frames from dkrap360.mp4 for BizHawk gui.drawImage().
// Also extracts audio-only track for the OBS overlay.
//
// Requirements: ffmpeg must be installed and in PATH
// Usage: node extract-frames.js
// ──────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────
const MP4_PATH       = path.join(__dirname, 'dkrap360.mp4');
const FRAMES_DIR     = path.join(__dirname, 'bizhawk', 'dkrap_frames');
const AUDIO_OUT      = path.join(__dirname, 'bizhawk', 'dkrap_audio.m4a');
const FPS            = 15;            // frames per second to extract
const DURATION_S     = 185;           // match dkRapDurationMs (185000ms)
const WIDTH          = 256;           // SNES native width
const HEIGHT         = 224;           // SNES native height
const JPEG_QUALITY   = 5;            // ffmpeg -q:v (2=best, 5=good, 10=low)

const TOTAL_FRAMES   = DURATION_S * FPS;  // 2775

// ── Preflight checks ───────────────────────────────────────
console.log('\n  DK Rap Frame Extractor');
console.log('  =====================\n');

// Check ffmpeg
try {
  execSync('ffmpeg -version', { stdio: 'pipe' });
  console.log('  ✓ ffmpeg found');
} catch {
  console.error('  ✗ ffmpeg not found! Install it first: https://ffmpeg.org/download.html');
  process.exit(1);
}

// Check MP4 exists
if (!fs.existsSync(MP4_PATH)) {
  console.error(`  ✗ MP4 not found: ${MP4_PATH}`);
  console.error('    Place dkrap360.mp4 in the project root directory.');
  process.exit(1);
}
console.log(`  ✓ Source: ${MP4_PATH}`);

// Create output directory
if (!fs.existsSync(FRAMES_DIR)) {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  console.log(`  ✓ Created: ${FRAMES_DIR}`);
} else {
  // Clean existing frames
  const existing = fs.readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg'));
  if (existing.length > 0) {
    console.log(`  ! Cleaning ${existing.length} existing frames...`);
    existing.forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));
  }
  console.log(`  ✓ Output: ${FRAMES_DIR}`);
}

// ── Extract video frames ───────────────────────────────────
console.log(`\n  Extracting ${TOTAL_FRAMES} frames (${FPS}fps × ${DURATION_S}s) at ${WIDTH}×${HEIGHT}...`);
console.log('  This may take a minute...\n');

const videoFilter = [
  `fps=${FPS}`,
  `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease`,
  `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`
].join(',');

const frameCmd = [
  'ffmpeg',
  '-y',                                    // overwrite
  '-i', `"${MP4_PATH}"`,                   // input
  '-t', String(DURATION_S),                // only first 185 seconds
  '-vf', `"${videoFilter}"`,               // scale + letterbox
  '-q:v', String(JPEG_QUALITY),            // JPEG quality
  `"${path.join(FRAMES_DIR, 'frame_%04d.jpg')}"`  // output pattern
].join(' ');

try {
  execSync(frameCmd, { stdio: 'inherit', timeout: 300000 });
} catch (err) {
  console.error('\n  ✗ Frame extraction failed!');
  console.error('    Command:', frameCmd);
  process.exit(1);
}

// Count extracted frames
const frameFiles = fs.readdirSync(FRAMES_DIR).filter(f => f.match(/^frame_\d{4}\.jpg$/));
console.log(`\n  ✓ Extracted ${frameFiles.length} frames`);

// Calculate total size
const totalBytes = frameFiles.reduce((sum, f) => {
  return sum + fs.statSync(path.join(FRAMES_DIR, f)).size;
}, 0);
const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
console.log(`  ✓ Total size: ${totalMB} MB`);

// ── Extract audio-only track ───────────────────────────────
console.log('\n  Extracting audio track...');

const audioCmd = [
  'ffmpeg',
  '-y',
  '-i', `"${MP4_PATH}"`,
  '-t', String(DURATION_S),
  '-vn',                                   // no video
  '-c:a', 'aac',
  '-b:a', '128k',
  `"${AUDIO_OUT}"`
].join(' ');

try {
  execSync(audioCmd, { stdio: 'inherit', timeout: 60000 });
  console.log(`  ✓ Audio: ${AUDIO_OUT}`);
} catch {
  console.warn('  ! Audio extraction failed (non-critical — MP4 can be used directly)');
}

// ── Write metadata ────────────────────────────────────────
const info = {
  totalFrames: frameFiles.length,
  fps: FPS,
  durationMs: DURATION_S * 1000,
  width: WIDTH,
  height: HEIGHT,
  sourceFile: 'dkrap360.mp4',
  extractedAt: new Date().toISOString()
};

fs.writeFileSync(
  path.join(FRAMES_DIR, 'info.json'),
  JSON.stringify(info, null, 2)
);
console.log(`  ✓ Metadata: ${path.join(FRAMES_DIR, 'info.json')}`);

// ── Done ──────────────────────────────────────────────────
console.log(`
  ══════════════════════════════════
  Done! ${frameFiles.length} frames ready in bizhawk/dkrap_frames/

  Each streamer needs this folder in their bizhawk/ directory.
  Audio overlay served from: /media/dkrap_audio.m4a
  ══════════════════════════════════
`);
