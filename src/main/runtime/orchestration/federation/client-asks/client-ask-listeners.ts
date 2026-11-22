// Which paired computers are taking asks from this Orca's agents right now. A computer listens from
// its first pull in a session until a pull's caller goes away or it leaves; an answered pull keeps it,
// since it pulls again at once. Nothing is timed, and a server restart starts with none.
import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'
import type { PeerMailClientAsksPull } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'

export type ClientAskListener = {
  deviceId: string
  installationId: string
  name: string
  /** The pairing fingerprint this Orca keys the computer's conversations by. */
  fingerprint: string
  session: string
}

export type ClientAskPull = { key: string; session: string }

/** The runtime whose server the computers listen on; a test's runtimes keep separate listeners. */
export type ClientAskListenerOwner = Pick<OrcaRuntimeService, 'getOrchestrationDb'>

const listenersByOwner = new WeakMap<ClientAskListenerOwner, Map<string, ClientAskListener>>()
// The name each computer last pulled with, so a send while it's away can still name it.
const namesByOwner = new WeakMap<ClientAskListenerOwner, Map<string, string>>()
// The pairing each re-made pairing replaced, as its computer said: the one way a conversation of an
// older pairing reaches another device. Kept since this Orca started, as names are.
const successorsByOwner = new WeakMap<ClientAskListenerOwner, Map<string, string>>()

function listenersOf(owner: ClientAskListenerOwner): Map<string, ClientAskListener> {
  let listeners = listenersByOwner.get(owner)
  if (!listeners) {
    listeners = new Map()
    listenersByOwner.set(owner, listeners)
  }
  return listeners
}

const keyOf = (deviceId: string, installationId: string): string => `${deviceId}\0${installationId}`

/** A pull naming a session begins; a leave ends the session and returns null. */
export function clientAskPullStarted(
  owner: ClientAskListenerOwner,
  caller: { deviceId: string; fingerprint: string },
  pull: z.infer<typeof PeerMailClientAsksPull>
): ClientAskPull | null {
  const listeners = listenersOf(owner)
  const key = keyOf(caller.deviceId, pull.installationId)
  const current = listeners.get(key)
  if (pull.leave) {
    if (current?.session === pull.session) {
      listeners.delete(key)
    }
    return null
  }
  if (pull.previousPairing !== undefined && pull.previousPairing !== caller.fingerprint) {
    const successors = successorsByOwner.get(owner) ?? new Map<string, string>()
    successorsByOwner.set(owner, successors)
    successors.set(pull.previousPairing, caller.fingerprint)
  }
  // The pairing it replaced pulls no more, so that pairing's last session stops counting.
  for (const [other, listener] of listeners) {
    if (
      pull.previousPairing !== undefined &&
      listener.fingerprint === pull.previousPairing &&
      listener.installationId === pull.installationId
    ) {
      listeners.delete(other)
    }
  }
  let names = namesByOwner.get(owner)
  if (!names) {
    names = new Map()
    namesByOwner.set(owner, names)
  }
  names.set(pull.installationId, pull.name)
  listeners.set(key, {
    deviceId: caller.deviceId,
    installationId: pull.installationId,
    name: pull.name,
    fingerprint: caller.fingerprint,
    session: pull.session
  })
  return { key, session: pull.session }
}

/** An answered pull keeps its session; one whose caller went away ends it. Either touches only its own session. */
export function clientAskPullEnded(
  owner: ClientAskListenerOwner,
  pull: ClientAskPull,
  outcome: 'answered' | 'caller_gone'
): void {
  const listeners = listenersOf(owner)
  const current = listeners.get(pull.key)
  if (outcome === 'caller_gone' && current?.session === pull.session) {
    listeners.delete(pull.key)
  }
}

/** The listening computers a selector names: its installation id, or its name. */
export function listeningClients(
  owner: ClientAskListenerOwner,
  selector: string
): ClientAskListener[] {
  const wanted = selector.trim().toLowerCase()
  return [...listenersOf(owner).values()].filter(
    (listener) =>
      listener.installationId === selector.trim() || listener.name.trim().toLowerCase() === wanted
  )
}

/** The name a computer last pulled with since this Orca started; null for one it hasn't seen. */
export function lastClientAskName(
  owner: ClientAskListenerOwner,
  installationId: string
): string | null {
  return namesByOwner.get(owner)?.get(installationId.trim()) ?? null
}

export function forgetClientAskDevice(owner: ClientAskListenerOwner, deviceId: string): void {
  const listeners = listenersOf(owner)
  for (const [key, listener] of listeners) {
    if (listener.deviceId === deviceId) {
      listeners.delete(key)
    }
  }
}

/** The one listening computer a selector names; refused when none is connected or two share it. */
export function requireListeningClient(
  owner: ClientAskListenerOwner,
  selector: string,
  nothingDone: string
): ClientAskListener {
  const listening = listeningClients(owner, selector)
  if (listening.length > 1) {
    throw new OrchestrationError(
      'invalid_argument',
      `Two paired computers answer to ${selector}. ${nothingDone}`,
      { effectsApplied: false }
    )
  }
  const [client] = listening
  if (!client) {
    throw new OrchestrationError(
      'remote_runtime_unavailable',
      `${selector} is offline: it isn't connected to this Orca right now. ${nothingDone}`,
      { effectsApplied: false }
    )
  }
  return client
}

// Re-pairs one pairing can go through before its conversations are no longer followed.
const MAX_REPAIRS = 8

/** The listening computer a conversation's environment names: the same device, or the device of the
 *  pairing that replaced the conversation's own. A copy sharing the installation id under a pairing
 *  of its own never takes it; while none is listening, the reply waits for the original's pull. */
export function listenerForClientEnvironment(
  owner: ClientAskListenerOwner,
  conversation: { deviceId: string; installationId: string; pairing: string }
): ClientAskListener | null {
  const listeners = listenersOf(owner)
  const same = listeners.get(keyOf(conversation.deviceId, conversation.installationId))
  if (same) {
    return same
  }
  const successors = successorsByOwner.get(owner)
  let pairing = successors?.get(conversation.pairing)
  for (let hop = 0; pairing !== undefined && hop < MAX_REPAIRS; hop += 1) {
    const current = pairing
    const repaired = [...listeners.values()].find(
      (listener) =>
        listener.fingerprint === current && listener.installationId === conversation.installationId
    )
    if (repaired) {
      return repaired
    }
    pairing = successors?.get(current)
  }
  return null
}
