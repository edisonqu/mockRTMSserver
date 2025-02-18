const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = 8000;

// Middleware to parse incoming JSON payloads
app.use(express.json());

// Configuration - Replace with actual values, test values can be found in data/rtms_credentials.json
const ZOOM_SECRET_TOKEN = 'DyBoLm8OZoJT2Pi3-kY2px'; // Webhook secret for validation 
const CLIENT_SECRET = 'YZnKVUufg7N18Oej6gHHqNWc7CG5jQ6N'; // Secret key for generating HMAC signatures

// Track active connections
const activeConnections = new Map();

/**
 * Function to generate HMAC signature
 * 
 * @param {string} clientId - The client ID of the RTMS application
 * @param {string} meetingUuid - The UUID of the Zoom meeting
 * @param {string} streamId - The RTMS stream ID
 * @param {string} secret - The secret key used for signing
 * @returns {string} HMAC SHA256 signature
 */
function generateSignature(clientId, meetingUuid, streamId, secret) {
    const message = `${clientId},${meetingUuid},${streamId}`;
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Webhook endpoint to receive events from Zoom
 */
app.post('/', (req, res) => {
    const { event, payload } = req.body;

    // Handle Zoom Webhook validation
    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        
        console.log('Received URL validation request:', {
            event,
            plainToken: payload.plainToken
        });

        const hashForValidate = crypto.createHmac('sha256', ZOOM_SECRET_TOKEN)
            .update(payload.plainToken)
            .digest('hex');
            
        const response = {
            plainToken: payload.plainToken,
            encryptedToken: hashForValidate
        };
        
        console.log('Sending URL validation response:', response);
        return res.json(response);
    }

    // Handle RTMS start event
    if (payload?.event === 'meeting.rtms.started' && payload?.payload?.object) {
        const {
            clientId,
            payload: {
                payload: {
                    object: { meeting_uuid, rtms_stream_id, server_urls }
                }
            }
        } = req.body;

        connectToRTMSWebSocket(clientId, meeting_uuid, rtms_stream_id, server_urls);
    }

    res.sendStatus(200);
});

/**
 * Connects to the RTMS signaling WebSocket server
 * 
 * @param {string} clientId - The client ID
 * @param {string} meetingUuid - The meeting UUID
 * @param {string} streamId - The RTMS stream ID
 * @param {string} serverUrl - WebSocket URL for signaling server
 */
function connectToRTMSWebSocket(clientId, meetingUuid, streamId, serverUrl) {
    const connectionId = `${meetingUuid}_${streamId}`;
    
    // Close existing connection if any
    if (activeConnections.has(connectionId)) {
        activeConnections.get(connectionId).close();
        activeConnections.delete(connectionId);
    }

    const ws = new WebSocket(serverUrl, { rejectUnauthorized: false });
    activeConnections.set(connectionId, ws);

    ws.on("open", () => {
        const signature = generateSignature(clientId, meetingUuid, streamId, CLIENT_SECRET);
        const handshakeMessage = {
            msg_type: "SIGNALING_HAND_SHAKE_REQ",
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature: signature
        };
        ws.send(JSON.stringify(handshakeMessage));
    });

    ws.on("message", (data) => {
        const message = JSON.parse(data);
        
        // Handle different message types
        switch (message.msg_type) {
            case "SIGNALING_HAND_SHAKE_RESP":
                if (message.status_code === "STATUS_OK") {
                    const mediaServerUrl = message.media_server.server_urls.transcript;
                    connectToMediaWebSocket(mediaServerUrl, clientId, meetingUuid, streamId);
                }
                break;
            case "STREAM_STATE_UPDATE":
                if (message.state === "TERMINATED") {
                    ws.close();
                    activeConnections.delete(connectionId);
                }
                break;
            case "KEEP_ALIVE_REQ":
                ws.send(JSON.stringify({
                    msg_type: "KEEP_ALIVE_RESP",
                    timestamp: Date.now()
                }));
                break;
        }
    });

    ws.on("close", () => {
        activeConnections.delete(connectionId);
    });
}

/**
 * Connects to the Media WebSocket server
 * 
 * @param {string} endpoint - WebSocket URL for media server
 * @param {string} clientId - The client ID
 * @param {string} meetingUuid - The meeting UUID
 * @param {string} streamId - The RTMS stream ID
 */
function connectToMediaWebSocket(endpoint, clientId, meetingUuid, streamId) {
    const connectionId = `${meetingUuid}_${streamId}_media`;
    
    // Close existing media connection if any
    if (activeConnections.has(connectionId)) {
        activeConnections.get(connectionId).close();
        activeConnections.delete(connectionId);
    }

    const mediaWs = new WebSocket(endpoint, { rejectUnauthorized: false });
    activeConnections.set(connectionId, mediaWs);

    mediaWs.on("open", () => {
        const mediaSignature = generateSignature(clientId, meetingUuid, streamId, CLIENT_SECRET);
        const dataHandshakeMessage = {
            msg_type: "DATA_HAND_SHAKE_REQ",
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature: mediaSignature,
            payload_encryption: false
        };
        mediaWs.send(JSON.stringify(dataHandshakeMessage));
    });

    function saveTranscript(transcriptData) {
        const timestamp = new Date().toLocaleTimeString();
        const transcriptDir = path.join(__dirname, 'transcripts');
        const singleTranscriptFile = path.join(transcriptDir, 'complete_transcript.txt');
        
        // Create transcripts directory if it doesn't exist
        if (!fs.existsSync(transcriptDir)) {
            fs.mkdirSync(transcriptDir, { recursive: true });
        }
        
        // Append the transcript with timestamp
        const formattedTranscript = `[${timestamp}] ${transcriptData}\n`;
        
        fs.appendFile(singleTranscriptFile, formattedTranscript, (err) => {
            if (err) {
                console.error('Error saving transcript:', err);
            } else {
                console.log('Transcript saved to:', singleTranscriptFile);
            }
        });
    }

    mediaWs.on("message", async (data) => {
        const message = JSON.parse(data);

        console.log("hello hello hello", message);
        
        // Check if it's a transcript message
        if (message.msg_type === "MEDIA_DATA_TRANSCRIPT" && message.content?.data) {
            // Save transcript locally
            saveTranscript(message.content.data);
            

        }


        if(message.msg_type === "STREAM_STATE_UPDATE" && message.state === "TERMINATED"){            
            try {
                const transcriptDir = path.join(__dirname, 'transcripts');
                const transcriptFile = path.join(transcriptDir, 'complete_transcript.txt');
                
                // Read the entire transcript file
                const fullTranscript = fs.readFileSync(transcriptFile, 'utf8');

                console.log(fullTranscript);
                
                
                const url = 'https://magicloops.dev/api/loop/e18e2d95-a443-47f8-95ea-099095414b72/run';
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ 
                        "transcript": fullTranscript 
                    }),
                });
                
                // Clear the transcripts directory after sending
                fs.rmSync(transcriptDir, { recursive: true, force: true });
                fs.mkdirSync(transcriptDir);
                
                const responseJson = await response.json();
                console.log('Magic Loops API response:', responseJson);
            } catch (error) {
                console.error('Error sending transcript to Magic Loops:', error);
            }
        }
    });

    mediaWs.on("close", () => {
        activeConnections.delete(connectionId);
    });
}

// Start the Express server
app.listen(PORT, () => {
    console.log(`Zoom Webhook listening on port ${PORT}`);
});

// Clean up connections on exit
process.on("SIGINT", () => {
    for (const ws of activeConnections.values()) {
        ws.close();
    }
    process.exit(0);
});
