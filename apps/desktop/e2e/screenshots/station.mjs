// A local Icecast-shaped radio station, so the streams scene captures the app
// genuinely connected to live radio rather than a mocked-up transport.
//
// Everything the stream screenshot shows — the LIVE indicator in place of the
// seek row, the missing prev/next, the ICY song title under the station name,
// the station's own artwork — is state only a real connection produces. The
// engine reaches it through icy.rs the same way it reaches a real station: an
// HTTP response typed audio/mpeg, carrying `icy-name` and `icy-metaint`, whose
// body interleaves a metadata block into the audio every METAINT bytes.
//
// The audio is the app's own bundled sample looped end to end. Nothing about it
// reaches a pixel (every scene runs at volume 0); it exists so the decoder has
// real MPEG frames to chew on, which is what makes the transport go live.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Icecast's own default. Small enough that the first title reaches the decoder
// within a fraction of a second of the connection opening.
const METAINT = 8192;

// The frame region of an MP3, with the container tags stripped off both ends so
// it can be looped end to end: an ID3 header reappearing mid-stream is not
// something a radio server ever sends, and a demuxer already past the start of a
// live stream has no reason to expect one.
function mpegFrames(buf, file) {
  let start = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  let end = buf.length;
  if (end - start > 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  if (end - start < METAINT || buf[start] !== 0xff || (buf[start + 1] & 0xe0) !== 0xe0) {
    throw new Error(`${file} holds no loopable run of MPEG frames once its tags are stripped`);
  }
  return buf.subarray(start, end);
}

// One in-band metadata block: a length byte counting 16-byte units, then the
// padded payload. A zero-length block is the "nothing changed" filler Icecast
// sends between songs, which is every block after the first here — the station
// plays one song forever.
function icyBlock(title) {
  if (!title) return Buffer.from([0]);
  const text = Buffer.from(`StreamTitle='${title}';`, 'utf8');
  const units = Math.ceil(text.length / 16);
  if (units > 255) throw new Error('ICY title too long for one metadata block');
  const block = Buffer.alloc(1 + units * 16);
  block[0] = units;
  text.copy(block, 1);
  return block;
}

// Writes the interleaved body until the client hangs up. Audio bytes are
// counted (metadata blocks are not) so the blocks land exactly METAINT apart,
// which is the only thing keeping the decoder's byte stream in sync. Writing
// stops at the first back-pressured write and resumes on drain, so a client
// reading at playback rate leaves this idle rather than buffering the loop.
function pump(res, frames, title) {
  let at = 0, untilMeta = METAINT, announced = false, closed = false;
  res.on('close', () => { closed = true; });
  const write = () => {
    while (!closed) {
      const take = Math.min(untilMeta, frames.length - at);
      let ready = res.write(frames.subarray(at, at + take));
      at = (at + take) % frames.length;
      untilMeta -= take;
      if (untilMeta === 0) {
        untilMeta = METAINT;
        const blocked = !res.write(icyBlock(announced ? null : title));
        announced = true;
        ready = ready && !blocked;
      }
      if (!ready) return void res.once('drain', write);
    }
  };
  write();
}

// Starts the station on an ephemeral loopback port and hands back the URLs the
// fixture stream list points at. `close` ends it and drops the open connection,
// which an endless response body would otherwise hold forever.
export async function startStation({ name, title, logo, logoFile, audioFile }) {
  const frames = mpegFrames(await readFile(audioFile), audioFile);
  // Served under the artwork's own extension and content type, the way a real
  // stream list's tvg-logo points at an ordinary image URL.
  const extension = path.extname(logoFile).toLowerCase();
  const logoRoute = `/logo${extension}`;
  const logoType = extension === '.png' ? 'image/png' : 'image/jpeg';
  const sockets = new Set();
  const server = createServer((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    if (route === logoRoute) {
      res.writeHead(200, { 'Content-Type': logoType, 'Content-Length': logo.length });
      res.end(logo);
      return;
    }
    if (route !== '/stream') {
      res.writeHead(404).end();
      return;
    }
    // Framed the way a station frames it: no length, no chunking, the body
    // running until the connection closes. Node would otherwise reach for
    // chunked encoding, which no Icecast server sends and which would put a
    // layer between the engine and the bytes it is being tested against.
    res.useChunkedEncodingByDefault = false;
    res.shouldKeepAlive = false;
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'close',
      'icy-name': name,
      'icy-metaint': String(METAINT),
    });
    pump(res, frames, title);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    streamUrl: `${origin}/stream`,
    logoUrl: `${origin}${logoRoute}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
