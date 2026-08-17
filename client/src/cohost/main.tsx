import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CoHost } from './CoHost.js'
import './cohost.css'

/**
 * The co-host's own entry.
 *
 * A third document, separate from the station and the landing page, and the
 * reason is the device rather than tidiness. The station's bundle carries a
 * globe, a gramophone and three.js; the console carries the whole desk. Neither
 * is what you want to hand somebody on a phone in a kitchen who has to press
 * one button in the next four seconds — on a mobile connection, over an evening,
 * on a battery.
 *
 * What it shares is everything that matters and nothing that is heavy: the
 * clock, the socket, the audio graph, the microphone rig, the WebRTC. Those are
 * the parts where two implementations would drift, and drifting on the clock is
 * the one thing this project cannot survive.
 */

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <CoHost />
  </StrictMode>,
)
