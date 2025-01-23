const WebSocket = require('ws');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');


// Port configuration
const HANDSHAKE_PORT = 9092;
const MEDIA_STREAM_PORT = 8081;

// stream start time
let streamStartTime = null;
let audioStartTime = null;

// Directory for audio and video files
const DATA_DIR = path.resolve(__dirname, 'data');
const PCM_DIR = path.resolve(__dirname, 'data');

// Ensure PCM directory exists
if (!fs.existsSync(PCM_DIR)) {
    fs.mkdirSync(PCM_DIR, { recursive: true });
}

// Express app and WebSocket servers
const app = express();
let mediaServer = null;
let mediaWebSocketServer;
let isHandshakeServerActive = false;

// Keep track of sessions and client connections
const clientSessions = new Map();
const KEEP_ALIVE_INTERVAL = 5000;
const STREAM_CHUNK_SIZE = 4096; // 4KB chunks for streaming
const AUDIO_INTERVAL_MS = 100; // Send audio data every 100ms

// Helper to generate unique sequences
let sequenceCounter = 0;
function generateSequence() {
    sequenceCounter += 1;
    return sequenceCounter;
}

// Convert a media file to PCM format
function convertToPCM(inputFile, outputFile, callback) {
    const command = `ffmpeg -y -i "${inputFile}" -f s16le -acodec pcm_s16le -ar 44100 -ac 2 "${outputFile}"`;
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error converting file ${inputFile}:`, error);
        } else {
            console.log(`Converted ${inputFile} to ${outputFile}`);
        }
        callback(error);
    });
}

// Convert all files in the data directory to PCM format
function initializePCMConversion(callback) {
    const files = fs.readdirSync(DATA_DIR).filter((file) =>
        file.endsWith('.m4a') || file.endsWith('.mp4')
    );

    let remaining = files.length;
    if (remaining === 0) {
        callback();
        return;
    }

    files.forEach((file) => {
        const inputFile = path.join(DATA_DIR, file);
        const outputFile = path.join(PCM_DIR, `${path.parse(file).name}.pcm`);
        convertToPCM(inputFile, outputFile, (error) => {
            if (--remaining === 0) {
                callback();
            }
        });
    });
}

console.log('Starting WSS servers...');

function closeMediaServer() {
    if (mediaServer) {
        mediaServer.clients.forEach(client => {
            try {
                client.send(JSON.stringify({
                    msg_type: 'STREAM_STATE_UPDATE',
                    rtms_stream_id: client.rtmsStreamId,
                    state: 'TERMINATED',
                    reason: 'STOP_BC_CONNECTION_INTERRUPTED',
                    timestamp: Date.now()
                }));
                client.close();
            } catch (error) {
                console.error('Error closing media client:', error);
            }
        });
        
        mediaServer.close(() => {
            console.log('Media server closed');
            mediaServer = null;
        });
    }
}

function startMediaServer() {
    if (!isHandshakeServerActive) {
        console.error('Cannot start media server: Handshake server is not active');
        return null;
    }

    if (!mediaServer) {
        mediaServer = new WebSocket.Server({ host: '0.0.0.0', port: 8081 }, (error) => {
            if (error) {
                console.error('Failed to start media WSS server:', error);
                return;
            }
            console.log(`Media WSS server is running on port ${MEDIA_STREAM_PORT}`);
            setupMediaWebSocketServer(mediaServer);
        });

        mediaServer.on('error', (error) => {
            console.error('Media WSS server error:', error);
        });

        mediaServer.on('close', () => {
            console.log('Media server closed');
            mediaServer = null;
        });
    }
    return mediaServer;
}

// Only start handshake server initially
const wss = new WebSocket.Server({ host: '0.0.0.0', port: 9092 });

wss.on('connection', (ws) => {
    console.log('New handshake connection established');
    
    // Handle handshake disconnection
    ws.on('close', () => {
        console.log('Handshake connection closed');
        isHandshakeServerActive = false;
        closeMediaServer();
    });

    // Handle handshake errors
    ws.on('error', () => {
        console.log('Handshake connection error');
        isHandshakeServerActive = false;
        closeMediaServer();
    });
    
    // Only start media server after successful handshake
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            if (message.msg_type === 'SIGNALING_HAND_SHAKE_REQ') {
                startMediaServer();  // Allow media server to restart if needed
                handleSignalingHandshake(ws, message);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
});

wss.on('listening', () => {
    console.log(`Handshake WSS server is running on port ${HANDSHAKE_PORT}`);
    isHandshakeServerActive = true;
});

wss.on('close', () => {
    console.log('Handshake server closed');
    isHandshakeServerActive = false;
    closeMediaServer();
});

wss.on('error', (error) => {
    console.error('Handshake WSS server error:', error);
    isHandshakeServerActive = false;
    closeMediaServer();
});

// Signaling handshake handler
function handleSignalingHandshake(ws, message) {
    // Add version check
    if (message.protocol_version !== 1) {
        ws.send(JSON.stringify({
            msg_type: 'SIGNALING_HAND_SHAKE_RESP',
            protocol_version: 1,
            status_code: 'STATUS_INVALID_VERSION',
            reason: 'Unsupported protocol version'
        }));
        return;
    }
    
    const { meeting_uuid, rtms_stream_id, signature } = message;

    // Validate handshake request
    if (!rtms_stream_id || !signature) {
        ws.send(JSON.stringify({
            msg_type: 'SIGNALING_HAND_SHAKE_RESP',
            protocol_version: 1,
            status_code: 'STATUS_INVALID_MESSAGE',
            reason: 'Missing required fields',
        }));
        return;
    }

    // Use placeholder values if necessary
    const validMeetingUuid = meeting_uuid || 'placeholder_meeting_uuid';
    const validRtmsStreamId = rtms_stream_id || 'placeholder_rtms_stream_id';

    // Store session with placeholder values
    clientSessions.set(ws, { meeting_uuid: validMeetingUuid, rtms_stream_id: validRtmsStreamId, handshakeCompleted: true });

    ws.send(JSON.stringify({
        msg_type: 'SIGNALING_HAND_SHAKE_RESP',
        protocol_version: 1,
        status_code: 'STATUS_OK',
        media_server: {
            server_urls: {
                audio: `wss://localhost:${MEDIA_STREAM_PORT}/audio`,
                video: `wss://localhost:${MEDIA_STREAM_PORT}/video`,
                transcript: `wss://localhost:${MEDIA_STREAM_PORT}/transcript`,
                all: `wss://localhost:${MEDIA_STREAM_PORT}/all`,
            },
            srtp_keys: {
                audio: crypto.randomBytes(32).toString('hex'),
                video: crypto.randomBytes(32).toString('hex'),
                share: crypto.randomBytes(32).toString('hex'),
            },
        },
    }));
}

// Handle event subscription
function handleEventSubscription(ws, message) {
    console.log('Handling event subscription:', message.events);
    // No response needed as per requirements
}

// Handle session state request
function handleSessionStateRequest(ws, message) {
    const { session_id } = message;

    // Mocked response for session state
    ws.send(JSON.stringify({
        msg_type: 'SESSION_STATE_RESP',
        session_id: session_id,
        session_state: 'STARTED' // Mocked state
    }));
}

// Setup media WebSocket server
function setupMediaWebSocketServer(wss) {
    wss.on('connection', (ws, req) => {
        if (!isHandshakeServerActive) {
            console.error('Handshake server is not active. Closing media connection.');
            ws.send(JSON.stringify({
                msg_type: 'STREAM_STATE_UPDATE',
                state: 'TERMINATED',
                reason: 'STOP_BC_CONNECTION_INTERRUPTED',
                timestamp: Date.now()
            }));
            ws.close(1008, 'Handshake server is not active');
            return;
        }

        console.log(`New WebSocket connection on media server (path: ${req.url})`);

        const path = req.url.replace('/', ''); // Extract channel name
        const validChannels = ['audio', 'video', 'transcript', 'all'];

        if (!validChannels.includes(path)) {
            console.error(`Invalid channel: ${path}`);
            ws.close(1008, 'Invalid channel');
            return;
        }

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                console.log('Received:', message);

                if (message.msg_type === 'DATA_HAND_SHAKE_REQ') {
                    handleDataHandshake(ws, message, path);
                } else {
                    console.error('Unknown message type:', message.msg_type);
                }
            } catch (error) {
                console.error('Error processing message:', error.message);
            }
        });

        ws.on('close', () => {
            console.log('Media server connection closed');
            clientSessions.delete(ws);
        });

        sendKeepAlive(ws);
    });
}

// Data handshake handler
function handleDataHandshake(ws, message, channel) {
    // Add version check
    if (message.protocol_version !== 1) {
        ws.send(JSON.stringify({
            msg_type: 'DATA_HAND_SHAKE_RESP',
            protocol_version: 1,
            status_code: 'STATUS_INVALID_VERSION',
            reason: 'Unsupported protocol version'
        }));
        return;
    }

    const { meeting_uuid, rtms_stream_id, payload_encryption, media_params } = message;

    let session = clientSessions.get(ws);
    if (!session) {
        console.warn('No session found for WebSocket. Initializing with placeholders.');
        session = {
            meeting_uuid: meeting_uuid || 'placeholder_meeting_uuid',
            rtms_stream_id: rtms_stream_id || 'placeholder_rtms_stream_id',
            handshakeCompleted: true,
        };
        clientSessions.set(ws, session);
    }

    session.channel = channel;
    session.payload_encryption = payload_encryption || false;

    ws.send(JSON.stringify({
        msg_type: 'DATA_HAND_SHAKE_RESP',
        protocol_version: 1,
        status_code: 'STATUS_OK',
        sequence: generateSequence(),
        payload_encrypted: session.payload_encryption,
    }));

    startMediaStreams(ws, channel);
}

// Start streaming media data
function startMediaStreams(ws, channel) {
    const audioFile = path.join(PCM_DIR, 'audio1241999856.pcm');
    const videoFile = path.join(PCM_DIR, 'video1241999856.dfpwm');
    const transcriptFile = path.join(PCM_DIR, 'audio1241999856.txt');

    if (!streamStartTime) {
        streamStartTime = Date.now();
    }

    let audioStream, videoStream;

    // Handle audio streaming
    if (channel === 'audio' || channel === 'all') {
        if (fs.existsSync(audioFile)) {
            audioStartTime = Date.now();
            streamAudio(ws, audioFile);
        } else {
            console.error('Audio PCM file not found:', audioFile);
        }
    }

    // Handle video streaming
    if (channel === 'video' || channel === 'all') {
        if (fs.existsSync(videoFile)) {
            streamVideo(ws, videoFile);
        } else {
            console.error('Video file not found:', videoFile);
        }
    }

    // Handle transcript streaming
    if (channel === 'transcript' || channel === 'all') {
        try {
            const transcripts = loadTranscriptsFromFile(transcriptFile);
            let transcriptIndex = 0;

            const intervalId = setInterval(() => {
                const currentTime = getCurrentPlaybackTime();
                
                while (transcriptIndex < transcripts.length && 
                       transcripts[transcriptIndex].timestamp <= currentTime) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            msg_type: 'TRANSCRIPT_DATA',
                            text: transcripts[transcriptIndex].text,
                            timestamp: transcripts[transcriptIndex].timestamp
                        }));
                    }
                    transcriptIndex++;
                }

                if (transcriptIndex >= transcripts.length) {
                    clearInterval(intervalId);
                }
            }, 100); // Check every 100ms

            ws.intervals = ws.intervals || [];
            ws.intervals.push(intervalId);
        } catch (error) {
            console.error('Error streaming transcript:', error);
        }
    }

    // Cleanup on connection close
    ws.on('close', () => {
        if (audioStream) audioStream.destroy();
        if (videoStream) videoStream.destroy();
        clearAllIntervals(ws);
    });
}

// Helper functions to split up the functionality
function streamAudio(ws, audioFile) {
    const audioStream = fs.createReadStream(audioFile, { highWaterMark: STREAM_CHUNK_SIZE });
    let chunks = [];
    
    audioStream.on('error', (error) => {
        console.error('Error streaming audio:', error);
        ws.close(1011, 'Error streaming audio');
    });

    audioStream.on('data', (chunk) => {
        chunks.push(chunk);
    });

    audioStream.on('end', () => {
        let chunkIndex = 0;
        const intervalId = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN && chunkIndex < chunks.length) {
                ws.send(JSON.stringify({
                    msg_type: 'MEDIA_DATA_AUDIO',
                    content: {
                        data: chunks[chunkIndex].toString('base64'),
                        timestamp: Date.now(),
                    },
                }));
                chunkIndex++;
            } else if (chunkIndex >= chunks.length) {
                clearInterval(intervalId);
            }
        }, AUDIO_INTERVAL_MS);

        // Store interval ID for cleanup
        ws.intervals = ws.intervals || [];
        ws.intervals.push(intervalId);
    });
}

// Add this function after streamAudio function
function streamVideo(ws, videoFile) {
    try {
        const videoData = fs.readFileSync(videoFile);
        const chunkSize = 1024; // Adjust based on your needs
        let chunkIndex = 0;
        const chunks = [];

        // Split video data into chunks
        for (let i = 0; i < videoData.length; i += chunkSize) {
            chunks.push(videoData.slice(i, i + chunkSize));
        }

        const intervalId = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN && chunkIndex < chunks.length) {
                ws.send(JSON.stringify({
                    msg_type: 'MEDIA_DATA_VIDEO',
                    content: {
                        data: chunks[chunkIndex].toString('base64'),
                        timestamp: getCurrentPlaybackTime(),
                        is_last: chunkIndex === chunks.length - 1
                    }
                }));
                chunkIndex++;
            } else if (chunkIndex >= chunks.length) {
                clearInterval(intervalId);
            }
        }, 33); // ~30fps

        ws.intervals = ws.intervals || [];
        ws.intervals.push(intervalId);
    } catch (error) {
        console.error('Error streaming video:', error);
        ws.close(1011, 'Error streaming video');
    }
}

// Helper function to clean up intervals
function clearAllIntervals(ws) {
    if (ws.intervals) {
        ws.intervals.forEach(intervalId => clearInterval(intervalId));
        ws.intervals = [];
    }
}

function loadTranscriptsFromFile(audioFile) {
    const transcriptFile = audioFile.replace('.pcm', '.txt');
    
    try {
        const transcriptContent = fs.readFileSync(transcriptFile, 'utf-8');
        // Split by full stop and trim
        const sentences = transcriptContent.split('.').map(sentence => sentence.trim()).filter(sentence => sentence.length > 0);
        
        return sentences.map((sentence, index) => ({
            timestamp: index * 2000, // Assuming each sentence is roughly 2 seconds apart
            text: sentence + '.'  // Add back the full stop
        }));
    } catch (error) {
        console.error('Error reading transcript file:', error);
        return [];
    }
}

function getCurrentPlaybackTime() {
    if (!streamStartTime) return 0;
    return Date.now() - streamStartTime;
}

// Keep-alive messages
function sendKeepAlive(ws) {
    const keepAliveInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                msg_type: 'KEEP_ALIVE_REQ',
                sequence: generateSequence(),
                timestamp: Date.now(),
            }));
        } else {
            clearInterval(keepAliveInterval);
        }
    }, KEEP_ALIVE_INTERVAL);
}

function cleanupConnection(ws) {
    clientSessions.delete(ws);
    if (ws.intervals) {
        ws.intervals.forEach(intervalId => clearInterval(intervalId));
        ws.intervals = [];
    }
    try {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    } catch (error) {
        console.error('Error closing WebSocket:', error);
    }
}

// Add stream state update handling
function sendStreamStateUpdate(ws, state, reason = null) {
    ws.send(JSON.stringify({
        msg_type: 'STREAM_STATE_UPDATE',
        rtms_stream_id: ws.rtmsStreamId,
        state: state, // ACTIVE|TERMINATED
        reason: reason, // STOP_BC_MEETING_ENDED, etc.
        timestamp: Date.now()
    }));
}

// Add event update handling for active speaker
function sendActiveSpeakerUpdate(ws, currentId, newId, name) {
    ws.send(JSON.stringify({
        msg_type: 'EVENT_UPDATE',
        event: {
            event_type: 'ACTIVE_SPEAKER_CHANGE',
            current_id: currentId, // 0|11223344 (0 means first speaker)
            new_id: newId,
            name: name,
            timestamp: Date.now()
        }
    }));
}

// Add participant join event handling
function sendParticipantJoinEvent(ws, participants) {
    ws.send(JSON.stringify({
        msg_type: 'EVENT_UPDATE',
        event: {
            event_type: 'PARTICIPANT_JOIN',
            participants: participants // Array of {user_id: number, name: string}
        }
    }));
}

// Add participant leave event handling
function sendParticipantLeaveEvent(ws, participantIds) {
    ws.send(JSON.stringify({
        msg_type: 'EVENT_UPDATE',
        event: {
            event_type: 'PARTICIPANT_LEAVE',
            participants: participantIds // Array of user_ids
        }
    }));
}

// Add session state update handling
function sendSessionStateUpdate(ws, sessionId, state, stopReason = null) {
    ws.send(JSON.stringify({
        msg_type: 'SESSION_STATE_UPDATE',
        session_id: sessionId,
        state: state, // STARTED|PAUSED|RESUMED|STOPPED
        stop_reason: stopReason, // Only included if state is STOPPED
        timestamp: Date.now()
    }));
}

// Add media data audio message handling
function sendMediaDataAudio(ws, userId, audioData) {
    ws.send(JSON.stringify({
        msg_type: 'MEDIA_DATA_AUDIO',
        content: {
            user_id: userId, // 0 means mixed audio
            data: audioData,
            timestamp: Date.now()
        }
    }));
}

// Add media data video message handling
function sendMediaDataVideo(ws, userId, videoData) {
    ws.send(JSON.stringify({
        msg_type: 'MEDIA_DATA_VIDEO',
        content: {
            user_id: userId,
            data: videoData
        }
    }));
}

// Add transcript data message handling
function sendTranscriptData(ws, userId, transcriptText) {
    ws.send(JSON.stringify({
        msg_type: 'MEDIA_DATA_TRANSCRIPT',
        content: {
            user_id: userId,
            timestamp: Date.now(),
            data: transcriptText
        }
    }));
}

const RTMS_STOP_REASON = {
    UNKNOWN: 'UNKNOWN',
    STOP_BC_HOST_TRIGGERED: 'STOP_BC_HOST_TRIGGERED',
    STOP_BC_USER_TRIGGERED: 'STOP_BC_USER_TRIGGERED', 
    STOP_BC_USER_LEFT: 'STOP_BC_USER_LEFT',
    STOP_BC_USER_EJECTED: 'STOP_BC_USER_EJECTED',
    STOP_BC_APP_DISABLED_BY_HOST: 'STOP_BC_APP_DISABLED_BY_HOST',
    STOP_BC_MEETING_ENDED: 'STOP_BC_MEETING_ENDED',
    STOP_BC_STREAM_CANCELED: 'STOP_BC_STREAM_CANCELED',
    STOP_BC_ALL_APPS_DISABLED: 'STOP_BC_ALL_APPS_DISABLED',
    STOP_BC_INTERNAL_EXCEPTION: 'STOP_BC_INTERNAL_EXCEPTION',
    STOP_BC_CONNECTION_TIMEOUT: 'STOP_BC_CONNECTION_TIMEOUT',
    STOP_BC_CONNECTION_INTERRUPTED: 'STOP_BC_CONNECTION_INTERRUPTED',
    STOP_BC_CONNECTION_CLOSED_BY_CLIENT: 'STOP_BC_CONNECTION_CLOSED_BY_CLIENT',
    STOP_BC_EXIT_SIGNAL: 'STOP_BC_EXIT_SIGNAL'
};

// Message Types
const RTMS_MESSAGE_TYPE = {
    UNKNOWN: 'UNKNOWN',
    SIGNALING_HANDSHAKE_REQ: 'SIGNALING_HANDSHAKE_REQ',
    SIGNALING_HANDSHAKE_RESP: 'SIGNALING_HANDSHAKE_RESP',
    DATA_HANDSHAKE_REQ: 'DATA_HANDSHAKE_REQ',
    DATA_HANDSHAKE_RESP: 'DATA_HANDSHAKE_RESP',
    EVENT_SUBSCRIPTION: 'EVENT_SUBSCRIPTION',
    EVENT_UPDATE: 'EVENT_UPDATE',
    STREAM_STATE_UPDATE: 'STREAM_STATE_UPDATE',
    SESSION_STATE_UPDATE: 'SESSION_STATE_UPDATE',
    SESSION_STATE_REQ: 'SESSION_STATE_REQ',
    SESSION_STATE_RESP: 'SESSION_STATE_RESP',
    KEEP_ALIVE_REQ: 'KEEP_ALIVE_REQ',
    KEEP_ALIVE_RESP: 'KEEP_ALIVE_RESP',
    MEDIA_DATA_AUDIO: 'MEDIA_DATA_AUDIO',
    MEDIA_DATA_VIDEO: 'MEDIA_DATA_VIDEO',
    MEDIA_DATA_SHARE: 'MEDIA_DATA_SHARE',
    MEDIA_DATA_CHAT: 'MEDIA_DATA_CHAT',
    MEDIA_DATA_TRANSCRIPT: 'MEDIA_DATA_TRANSCRIPT'
};

// Event Types
const RTMS_EVENT_TYPE = {
    ACTIVE_SPEAKER_CHANGE: 'ACTIVE_SPEAKER_CHANGE',
    PARTICIPANT_JOIN: 'PARTICIPANT_JOIN',
    PARTICIPANT_LEAVE: 'PARTICIPANT_LEAVE'
};

// Session States
const RTMS_SESSION_STATE = {
    INACTIVE: 'INACTIVE',
    INITIALIZE: 'INITIALIZE',
    STARTED: 'STARTED',
    PAUSED: 'PAUSED',
    RESUMED: 'RESUMED',
    STOPPED: 'STOPPED'
};

// Stream States
const RTMS_STREAM_STATE = {
    INACTIVE: 'INACTIVE',
    ACTIVE: 'ACTIVE',
    TERMINATED: 'TERMINATED',
    INTERRUPTED: 'INTERRUPTED'
};

// Media Types
const MEDIA_DATA_TYPE = {
    AUDIO: 1,
    VIDEO: 2,
    DESKSHARE: 3,
    TRANSCRIPT: 4,
    CHAT: 5,
    ALL: 6
};

// Media Content Types
const MEDIA_CONTENT_TYPE = {
    RTP: 1,
    RAW_AUDIO: 2,
    RAW_VIDEO: 3,
    FILE_STREAM: 4,
    TEXT: 5
};

// Default Media Parameters
const DEFAULT_AUDIO_PARAMS = {
    content_type: MEDIA_CONTENT_TYPE.RAW_AUDIO,
    sample_rate: 'SR_16K',
    channel: 'MONO',
    codec: 'L16',
    data_opt: 'AUDIO_MIXED_STREAM',
    send_interval: 20
};

const DEFAULT_VIDEO_PARAMS = {
    content_type: MEDIA_CONTENT_TYPE.RAW_VIDEO,
    codec: 'JPG',
    resolution: 'HD',
    fps: 5
};
