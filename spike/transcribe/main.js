/*
  Spike orchestration (main thread). Wires:
    getUserMedia → AudioContext → pcm-worklet → pushable async stream
      → StartStreamTranscription (AudioStream) → TranscriptResultStream → live UI

  Native ESM import, no bundler/npm install. The SDK's browser build streams over a
  SigV4-signed WebSocket under the hood (needs a secure context — localhost counts).
*/
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from 'https://esm.sh/@aws-sdk/client-transcribe-streaming@3'

const $ = (sel) => document.querySelector(sel)
const MAX_SECONDS = 180 // mirror the app's recording cap

let audioCtx, workletNode, source, stream, pushable
let running = false
let autoStopTimer = null
let startedAt = 0

function status(msg, kind = '') {
  const el = $('#status')
  el.textContent = msg
  el.dataset.kind = kind
}

/* A pushable async iterable: worklet pushes PCM frames in, the SDK pulls them out. */
function makePushable() {
  const queue = []
  let pending = null
  let ended = false
  return {
    push(chunk) {
      if (ended) return
      if (pending) {
        pending({ value: chunk, done: false })
        pending = null
      } else {
        queue.push(chunk)
      }
    },
    end() {
      ended = true
      if (pending) {
        pending({ value: undefined, done: true })
        pending = null
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { pending = resolve })
        },
      }
    },
  }
}

async function* audioStream() {
  for await (const bytes of pushable) {
    yield { AudioEvent: { AudioChunk: bytes } }
  }
}

async function start() {
  const region = $('#region').value.trim() || 'us-west-2'
  const accessKeyId = $('#akid').value.trim()
  const secretAccessKey = $('#secret').value.trim()
  const sessionToken = $('#token').value.trim() || undefined

  if (!accessKeyId || !secretAccessKey) {
    status('Paste temporary AWS credentials first (see README).', 'error')
    return
  }

  $('#start').disabled = true
  $('#partial').textContent = ''
  status('Requesting microphone…')

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
  } catch {
    status('Microphone permission denied.', 'error')
    $('#start').disabled = false
    return
  }

  // Request 16 kHz; if the browser won't honour it, the worklet downsamples from the real rate.
  audioCtx = new AudioContext({ sampleRate: 16000 })
  await audioCtx.audioWorklet.addModule('./pcm-worklet.js')
  source = audioCtx.createMediaStreamSource(stream)
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-downsampler', {
    processorOptions: { targetRate: 16000 },
  })

  pushable = makePushable()
  workletNode.port.onmessage = (e) => { if (running) pushable.push(new Uint8Array(e.data)) }

  // Connect worklet → destination so its process() is pulled every quantum. We never write to
  // the worklet's output, so the destination receives silence — no mic feedback/echo.
  source.connect(workletNode)
  workletNode.connect(audioCtx.destination)

  const client = new TranscribeStreamingClient({
    region,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
  })
  const command = new StartStreamTranscriptionCommand({
    LanguageCode: 'en-US',
    MediaEncoding: 'pcm',
    MediaSampleRateHertz: 16000,
    AudioStream: audioStream(),
  })

  running = true
  startedAt = performance.now()
  $('#stop').disabled = false
  status(`listening (context sample rate: ${audioCtx.sampleRate} Hz)`, 'live')
  tickTimer()
  autoStopTimer = setTimeout(() => stop('reached 180 s cap'), MAX_SECONDS * 1000)

  try {
    const response = await client.send(command)
    for await (const event of response.TranscriptResultStream) {
      const results = event.TranscriptEvent?.Transcript?.Results ?? []
      for (const result of results) {
        const text = result.Alternatives?.[0]?.Transcript ?? ''
        if (result.IsPartial) {
          $('#partial').textContent = text
        } else {
          appendFinal(text)
          $('#partial').textContent = ''
        }
      }
    }
    if (running) status('stream ended by server', '')
  } catch (err) {
    console.error(err)
    status(`error: ${err.name} — ${err.message}`, 'error')
  } finally {
    cleanup()
  }
}

function appendFinal(text) {
  if (!text) return
  const p = document.createElement('span')
  p.textContent = text + ' '
  $('#final').appendChild(p)
  $('#final').scrollTop = $('#final').scrollHeight
}

function tickTimer() {
  if (!running) return
  const secs = Math.floor((performance.now() - startedAt) / 1000)
  const m = Math.floor(secs / 60)
  const s = String(secs % 60).padStart(2, '0')
  $('#timer').textContent = `${m}:${s}`
  requestAnimationFrame(tickTimer)
}

function stop(reason) {
  if (!running) return
  running = false
  if (reason) status(reason, '')
  pushable?.end() // ends the AudioStream generator → server closes the transcript stream
}

function cleanup() {
  running = false
  $('#start').disabled = false
  $('#stop').disabled = true
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null }
  try { source?.disconnect() } catch {}
  try { workletNode?.disconnect() } catch {}
  stream?.getTracks().forEach((t) => t.stop())
  audioCtx?.close()
  source = workletNode = stream = audioCtx = null
}

$('#start').addEventListener('click', start)
$('#stop').addEventListener('click', () => stop('stopped'))
$('#clear').addEventListener('click', () => {
  $('#final').textContent = ''
  $('#partial').textContent = ''
})
