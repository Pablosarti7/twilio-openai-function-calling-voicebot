import dotenv from "dotenv-flow";
import express from "express";
import ExpressWs from "express-ws";
import config from "../config";
import log from "./logger";
import * as oai from "./openai";
import * as twlo from "./twilio";
import type { CallStatus } from "./types";
import { checkPowerOutage, updateAddress } from './functions';

dotenv.config();

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

/****************************************************
 Twilio Voice Webhook Endpoints
****************************************************/
app.post("/incoming-call", async (req, res) => {
  log.twl.info(`incoming-call from ${req.body.From} to ${req.body.To}`);

  try {
    oai.createWebsocket(); // This demo only supports one call at a time, hence a single OpenAI websocket is stored globally
    
    oai.onFunctionCall(async (functionName, parameters, call_id) => {
      let result;
      
      try {
        // Add more detailed debug logging
        log.oai.info(`Function call received - Name: ${functionName}`);
        log.oai.info('Raw parameters:', parameters);
        
        // Handle case where parameters might be a string
        let parsedParams = parameters;
        if (typeof parameters === 'string') {
          try {
            parsedParams = JSON.parse(parameters);
            log.oai.info('Parsed parameters:', parsedParams);
          } catch (e) {
            log.oai.error('Error parsing parameters:', e);
            parsedParams = {};
          }
        }

        switch (functionName) {
          case "check_power_outage":
            log.oai.info('Checking power outage with parameters:', parsedParams);
            result = await checkPowerOutage(parsedParams);
            log.oai.info('Power outage check result:', result);
            break;
          case "update_address":
            log.oai.info('Updating address with parameters:', parsedParams);
            result = await updateAddress(parsedParams);
            log.oai.info('Address update result:', result);
            break;
          default:
            log.oai.warn(`Unknown function ${functionName}`);
            return;
        }
    
        if (result) {
          log.oai.info('Sending function result back to OpenAI:', result);
          oai.ws?.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: call_id,
              output: JSON.stringify(result)
            }
          }));

          // Add a small delay before sending the next messages
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Clear any pending audio
          oai.clearAudio();
                    

          
          // Finally trigger a new response
          oai.ws?.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["text", "audio"]
            }
          }));
          
          log.oai.info("Function result sent and new response triggered");
          
          // Add a check for WebSocket state
          log.oai.info("OpenAI WebSocket state:", oai.ws?.readyState);
        } else {
          log.oai.warn('No result returned from function call');
        }
      } catch (error) {
        log.oai.error(`Error executing function ${functionName}:`, error);
        const err = error instanceof Error ? error : new Error(String(error));
        log.oai.error('Full error:', {
          message: err.message,
          stack: err.stack,
          details: err
        });
        oai.speak(`I apologize, but I encountered an error while processing your request. Please try again.`);
      }
    });

    oai.ws.on("open", () => log.oai.info("openai websocket opened"));
    oai.ws.on("error", (err) => log.oai.error("openai websocket error", err));
    oai.ws.on("close", () => {
      log.oai.warn("OpenAI WebSocket connection one closed");
    });
    // The incoming-call webhook is blocked until the OpenAI websocket is connected.
    // This ensures Twilio's Media Stream doesn't send audio packets to OpenAI prematurely.
    await oai.wsPromise;

    res.status(200);
    res.type("text/xml");

    // The <Stream/> TwiML noun tells Twilio to send the call to the websocket endpoint below.
    res.end(`
        <Response>
          <Connect>
            <Stream url="wss://${process.env.HOSTNAME}/media-stream" />
          </Connect>
        </Response>
        `);
  } catch (error) {
    log.oai.error(
      "incoming call webhook failed, probably because OpenAI websocket could not connect.",
      error
    );
    res.status(500).send();
  }
});

app.post("/call-status-update", async (req, res) => {
  const status = req.body.CallStatus as CallStatus;

  if (status === "error") log.twl.error(`call-status-update ${status}`);
  else log.twl.info(`call-status-update ${status}`);

  if (status === "error" || status === "completed") oai.closeWebsocket();

  res.status(200).send();
});

/****************************************************
 Twilio Media Stream Websocket Endpoint 
****************************************************/
app.ws("/media-stream", (ws, req) => {
  log.twl.info("incoming websocket");

  twlo.setWs(ws);
  twlo.ws.on("error", (err) => log.twl.error(`websocket error`, err));
  twlo.ws.on("close", () => {
    log.twl.warn("Twilio WebSocket connection closed");
  });

  // twilio media stream starts
  twlo.onMessage("start", (msg) => {
    log.twl.success("media stream started");
    twlo.setStreamSid(msg.streamSid);

    // OpenAI's websocket session parameters should probably be set when the it is
    // initialized. However, setting them slightly later (i.e. when the Twilio Media starts)
    // seems to make OpenAI's bot more responsive. I don't know why
    oai.setSessionParams();

    oai.speak(config.introduction); // tell OpenAI to speak the introduction
  });

  // relay audio packets between Twilio & OpenAI
  oai.onMessage("response.audio.delta", (msg) => twlo.sendAudio(msg.delta));
  twlo.onMessage("media", (msg) => {
    
    oai.sendAudio(msg.media.payload);
  });

  // user starts talking
  oai.onMessage("input_audio_buffer.speech_started", (msg) => {
    log.app.info("user started speaking");

    oai.clearAudio(); // tell OpenAI to stop sending audio
    twlo.clearAudio(); // tell Twilio to stop playing any audio that it has buffered
  });

  // bot final transcript
  oai.onMessage("response.audio_transcript.done", (msg) => {
    log.oai.info("bot transcript (final): ", msg.transcript);
  });

  oai.ws.on("close", () => {
    log.oai.warn("OpenAI WebSocket connection two closed");
  });
});

/****************************************************
 Start Server
****************************************************/
const port = process.env.PORT || "8080";
app.listen(port, () => {
  log.app.info(`server running on http://localhost:${port}`);
});
