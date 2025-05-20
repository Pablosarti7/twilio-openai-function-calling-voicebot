import WS from "ws";
import config from "../config";
import log from "./logger";
import type { OpenAIStreamMessage, OpenAIStreamMessageTypes } from "./types";

/****************************************************
 Websocket Lifecycle, see https://platform.openai.com/docs/guides/realtime/overview
****************************************************/
export let ws: WS; // This demo only supports on call at a time, hence the OpenAI websocket is globally scoped.
export let wsPromise: Promise<void>;

export function createWebsocket() {
  // websocket must be closed or uninitialized
  if (ws && ws?.readyState !== ws.CLOSED)
    throw Error(
      `There is already an active OpenAI websocket connection. This demo is limited to a single OpenAI connection at a time.`
    );

  wsPromise = new Promise<void>((resolve, reject) => {
    ws = new WS(config.openai.wsUrl, {
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    ws.on("open", () => resolve());
    ws.on("unexpected-response", (_, msg) => reject(msg));
  });

  return wsPromise;
}

export async function closeWebsocket(): Promise<void> {
  return new Promise((resolve) => {
    if (!ws) {
      log.oai.warn("no WebSocket connection to disconnect");
      resolve();
      return;
    }

    ws.on("close", () => resolve());

    ws.close();
  });
}

/****************************************************
 Websocket Actions, see https://platform.openai.com/docs/api-reference/realtime-client-events
****************************************************/
/** Clears OpenAI's audio buffer (https://platform.openai.com/docs/api-reference/realtime-client-events/input_audio_buffer/clear) */
export function clearAudio() {
  ws?.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
}

/** Create a response record that prompts the voicebot to say something (https://platform.openai.com/docs/api-reference/realtime-client-events/response/create) */
export function speak(text: string) {
  ws?.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions: `Say this verbatum:\n${text}`,
      },
    })
  );
}

/** Send raw audio packets to OpenAI's websocket (https://platform.openai.com/docs/api-reference/realtime-client-events/input_audio_buffer/append) */
export function sendAudio(audio: string) {
  ws?.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
}

/** Sets the OpenAI Realtime session parameter per the demo configuation.
 *
 * Note, these config params should probably be set when the OpenAI websocket is initialized
 * but, setting them slightly later (i.e. when the Twilio Media starts) seems to make
 * OpenAI's bot more responsive.
 */
export function setSessionParams() {
  ws?.send(
    JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["text", "audio"],
        turn_detection: { type: "server_vad" }, // VAD (voice activity detection) enables input_audio_buffer.speech_started / .speech_stopped
        tools: config.openai.tools,
        instructions: config.openai.instructions,
        temperature: config.openai.temperature,
        voice: config.openai.voice,
      },
    })
  );
}

/****************************************************
 Websocket Listeners, see https://platform.openai.com/docs/api-reference/realtime-server-events
****************************************************/
/** Adds an listener to an incoming message type */
export function onMessage<T extends OpenAIStreamMessageTypes>(
  type: T,
  callback: (message: OpenAIStreamMessage & { type: T }) => void
) {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as OpenAIStreamMessage;
    if (msg.type === type) callback(msg as OpenAIStreamMessage & { type: T });
  });
}
// instead of the current implementation for passing params, we can use the https://platform.openai.com/docs/guides/realtime-conversations#detect-when-the-model-wants-to-call-a-function
export function onFunctionCall(callback: (functionName: string, parameters: any, call_id: string) => void) {
  // Track function call state
  let currentCallId: string | null = null;
  let currentFunction: string | null = null;
  let currentParameters: string = '';

  // Listen for function call arguments
  onMessage("response.function_call_arguments.delta", (message) => {
    console.log("function call arguments", message);
    if (message.call_id) {
      currentCallId = message.call_id;
    }
  });

  // When function call is complete, execute callback
  onMessage("response.done", (message) => {
    console.log("function call done", message);
    if (message.response.output[0].type === "function_call" && currentCallId) {
      currentFunction = message.response.output[0].name;
      currentParameters = message.response.output[0].arguments;
      try {
        const parsedParams = JSON.parse(currentParameters);
        callback(currentFunction, parsedParams, currentCallId);
      } catch (e) {
        console.error('Error parsing function parameters:', e);
        callback(currentFunction, {}, currentCallId);
      }
      // Reset state
      currentCallId = null;
      currentFunction = null;
      currentParameters = '';
    }
  });
}
