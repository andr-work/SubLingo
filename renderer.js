// WhisperLiveKit WebSocket接続と音声処理
class TranscriptionClient {
    constructor() {
        this.ws = null;
        this.mediaRecorder = null;
        this.audioContext = null;
        this.stream = null;
        this.isRecording = false;
        this.startTime = null;
        this.timerInterval = null;
        this.serverUseAudioWorklet = false;
        this.configReadyResolve = null;
        this.configReady = new Promise((resolve) => {
            this.configReadyResolve = resolve;
        });
        this.chunkDuration = 100; // ミリ秒
        this.workletNode = null;
        this.recorderWorker = null;
        this.audioContext = null;
        this.microphone = null;

        this.initializeElements();
        this.setupEventListeners();
        this.loadMicrophones();
    }

    initializeElements() {
        this.recordButton = document.getElementById('recordButton');
        this.timer = document.getElementById('timer');
        this.status = document.getElementById('status');
        this.transcript = document.getElementById('transcript');
        this.microphoneSelect = document.getElementById('microphoneSelect');
        this.clearButton = document.getElementById('clearButton');
    }

    setupEventListeners() {
        this.recordButton.addEventListener('click', () => this.toggleRecording());
        this.clearButton.addEventListener('click', () => this.clearTranscript());
        this.microphoneSelect.addEventListener('change', () => {
            if (this.isRecording) {
                this.stopRecording();
            }
        });
    }

    async loadMicrophones() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(device => device.kind === 'audioinput');

            this.microphoneSelect.innerHTML = '<option value="">デフォルトマイク</option>';
            audioInputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `マイク ${this.microphoneSelect.options.length}`;
                this.microphoneSelect.appendChild(option);
            });
        } catch (error) {
            console.error('マイクの取得に失敗しました:', error);
            this.updateStatus('マイクの取得に失敗しました', 'error');
        }
    }

    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            try {
                // WebSocketが接続されていない場合は接続
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    await this.connectWebSocket();
                }
                // 設定が準備できるまで待ってから録音開始
                await this.startRecording();
            } catch (error) {
                console.error('録音開始エラー:', error);
                this.updateStatus('録音開始に失敗しました: ' + error.message, 'error');
            }
        }
    }

    async startRecording() {
        try {
            // 設定が準備できるまで待つ（タイムアウト5秒）
            const configWaitPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.warn('サーバー設定の受信がタイムアウトしました。デフォルト（MediaRecorder）で続行します。');
                    this.serverUseAudioWorklet = false;
                    resolve();
                }, 5000);

                this.configReady.then(() => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
            await configWaitPromise;

            const deviceId = this.microphoneSelect.value || undefined;
            const constraints = {
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                    sampleRate: 16000
                }
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);

            // AudioContextの初期化
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000,
            });

            // AudioWorkletを使用する場合（サーバー設定に基づく）
            if (this.serverUseAudioWorklet) {
                console.log('Using AudioWorklet for recording (PCM)...');

                try {
                    // WORKER / WORKLET コードのインライン定義 (Blob URL使用)
                    const pcmWorkletCode = `
class PCMForwarder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const channelData = input[0];
      const copy = new Float32Array(channelData.length);
      copy.set(channelData);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-forwarder', PCMForwarder);
`;

                    const recorderWorkerCode = `
let sampleRate = 48000;
let targetSampleRate = 16000;

self.onmessage = function (e) {
  switch (e.data.command) {
    case 'init':
      init(e.data.config);
      break;
    case 'record':
      record(e.data.buffer);
      break;
  }
};

function init(config) {
  sampleRate = config.sampleRate;
  targetSampleRate = config.targetSampleRate || 16000;
}

function record(inputBuffer) {
  const buffer = new Float32Array(inputBuffer);
  const resampledBuffer = resample(buffer, sampleRate, targetSampleRate);
  const pcmBuffer = toPCM(resampledBuffer);
  self.postMessage({ buffer: pcmBuffer }, [pcmBuffer]);
}

function resample(buffer, from, to) {
    if (from === to) return buffer;
    const ratio = from / to;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
        let accum = 0, count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
            accum += buffer[i];
            count++;
        }
        result[offsetResult] = accum / count;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
    }
    return result;
}

function toPCM(input) {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}
`;

                    // Blob URLの作成
                    const workletBlob = new Blob([pcmWorkletCode], { type: 'application/javascript' });
                    const workletUrl = URL.createObjectURL(workletBlob);

                    const workerBlob = new Blob([recorderWorkerCode], { type: 'application/javascript' });
                    const workerUrl = URL.createObjectURL(workerBlob);

                    // AudioWorkletのロード
                    await this.audioContext.audioWorklet.addModule(workletUrl);

                    this.microphone = this.audioContext.createMediaStreamSource(this.stream);
                    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-forwarder', {
                        numberOfInputs: 1,
                        numberOfOutputs: 0,
                        channelCount: 1
                    });

                    this.microphone.connect(this.workletNode);

                    // Workerの初期化
                    this.recorderWorker = new Worker(workerUrl);
                    this.recorderWorker.onerror = (e) => {
                        console.error("Worker Error:", e);
                    };

                    this.recorderWorker.postMessage({
                        command: 'init',
                        config: {
                            sampleRate: this.audioContext.sampleRate,
                            targetSampleRate: 16000
                        }
                    });

                    this.recorderWorker.onmessage = (e) => {
                        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                            // console.log(\`PCMデータ送信: \${e.data.buffer.byteLength} bytes\`);
                            this.ws.send(e.data.buffer);
                        }
                    };

                    this.workletNode.port.onmessage = (e) => {
                        const data = e.data;
                        const ab = data instanceof ArrayBuffer ? data : data.buffer;

                        if (this.recorderWorker) {
                            this.recorderWorker.postMessage({
                                command: 'record',
                                buffer: ab
                            }, [ab]);
                        }
                    };

                } catch (err) {
                    console.error('AudioWorklet setup failed, falling back to MediaRecorder:', err);
                    this.serverUseAudioWorklet = false;
                    // MediaRecorderへのフォールバック処理に進む
                    this.cleanupAudioContext(); // 部分的に作成されたリソースをクリーンアップ
                }
            }

            // MediaRecorderを使用（AudioWorkletが無効、または失敗した場合）
            if (!this.serverUseAudioWorklet) {
                console.log('Using MediaRecorder for recording (WebM)...');

                try {
                    this.mediaRecorder = new MediaRecorder(this.stream, {
                        mimeType: 'audio/webm'
                    });
                } catch (e) {
                    // WebMがサポートされていない場合はデフォルトを使用した後に確認
                    console.warn('WebM not supported, using default:', e);
                    this.mediaRecorder = new MediaRecorder(this.stream);
                }

                this.mediaRecorder.ondataavailable = (event) => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        if (event.data && event.data.size > 0) {
                            console.log(`音声データ送信: ${event.data.size} bytes, type: ${event.data.type}`);
                            this.ws.send(event.data);
                        }
                    }
                };

                // チャンクごとにデータを取得
                this.mediaRecorder.start(this.chunkDuration);
            }

            this.isRecording = true;
            this.startTime = Date.now();
            this.updateButton(true);
            this.startTimer();
            this.updateStatus('文字起こし中...', 'recording');
            this.clearTranscript();

            console.log('録音を開始しました');
        } catch (error) {
            console.error('文字起こしの開始に失敗しました:', error);
            this.updateStatus('文字起こしの開始に失敗しました: ' + error.message, 'error');
        }
    }

    async connectWebSocket(retries = 5, delay = 2000) {
        return new Promise((resolve, reject) => {
            const url = 'ws://localhost:8000/asr';
            let attempt = 0;
            this.connectResolve = resolve; // 後でconfigメッセージで解決する

            const tryConnect = () => {
                attempt++;
                if (attempt > retries) {
                    this.connectResolve = null;
                    reject(new Error(`WebSocket接続に失敗しました（${retries}回リトライ後）`));
                    return;
                }

                if (attempt > 1) {
                    this.updateStatus(`接続を試行中... (${attempt}/${retries})`, 'info');
                }

                try {
                    this.ws = new WebSocket(url);

                    this.ws.onopen = () => {
                        console.log('WebSocket接続が確立されました');
                        this.updateStatus('接続中...', 'info');
                        // resolveはconfigメッセージを受信してから実行される
                    };

                    this.ws.onmessage = (event) => {
                        try {
                            // JSONメッセージをパース
                            if (typeof event.data === 'string') {
                                const data = JSON.parse(event.data);
                                this.handleWebSocketMessage(data);
                            } else {
                                console.warn('バイナリメッセージを受信しました（予期しない形式）');
                            }
                        } catch (error) {
                            console.error('メッセージの解析に失敗しました:', error, event.data);
                        }
                    };

                    this.ws.onerror = (error) => {
                        console.error('WebSocketエラー:', error);
                        if (attempt < retries) {
                            this.updateStatus(`接続エラー。リトライ中... (${attempt}/${retries})`, 'error');
                            setTimeout(tryConnect, delay);
                        } else {
                            this.connectResolve = null;
                            this.updateStatus('接続エラー: サーバーに接続できません', 'error');
                            reject(error);
                        }
                    };

                    this.ws.onclose = (event) => {
                        console.log('WebSocket接続が閉じられました', event.code, event.reason);
                        if (this.isRecording && event.code !== 1000) {
                            // 正常終了でない場合のみリトライ
                            if (attempt < retries) {
                                this.updateStatus(`接続が切断されました。再接続中... (${attempt}/${retries})`, 'error');
                                setTimeout(tryConnect, delay);
                            } else {
                                this.connectResolve = null;
                                this.updateStatus('接続が切断されました', 'error');
                            }
                        }
                    };
                } catch (error) {
                    console.error('WebSocket作成エラー:', error);
                    if (attempt < retries) {
                        setTimeout(tryConnect, delay);
                    } else {
                        this.connectResolve = null;
                        reject(error);
                    }
                }
            };

            tryConnect();
        });
    }

    handleWebSocketMessage(data) {
        console.log('受信したメッセージ:', data);

        if (data.type === 'config') {
            console.log('設定を受信:', data);
            this.serverUseAudioWorklet = data.useAudioWorklet || false;

            // AudioWorkletの設定
            if (this.serverUseAudioWorklet) {
                console.log('✅ サーバー設定: AudioWorkletモード (PCM) が有効です');
            } else {
                console.log('ℹ️ サーバー設定: MediaRecorderモード (WebM) が有効です');
            }

            this.updateStatus('接続済み - 文字起こし準備完了', 'connected');
            // 設定が準備できたことを通知（connectWebSocketのPromiseを解決）
            if (this.configReadyResolve) {
                this.configReadyResolve();
                this.configReadyResolve = null;
            }
            // 接続が確立されたことを通知
            if (this.connectResolve) {
                this.connectResolve();
                this.connectResolve = null;
            }
        } else if (data.type === 'ready_to_stop') {
            console.log('転写が完了しました');
            this.updateStatus('転写が完了しました', 'info');
        } else if (data.type === 'error') {
            console.error('サーバーエラー:', data.message || data.error);
            this.updateStatus('エラー: ' + (data.message || data.error || '不明なエラー'), 'error');
        } else {
            // より詳細なメッセージ処理（Web版の実装に合わせる）
            const {
                lines = [],
                buffer_transcription = '',
                buffer_diarization = '',
                buffer_translation = '',
                status = 'active_transcription',
                text,
                transcript,
                is_final,
                final
            } = data;

            // lines配列がある場合（より詳細な応答）
            if (lines && lines.length > 0) {
                console.log(`受信: ${lines.length}行, バッファ転写=${buffer_transcription.length}文字, 状態=${status}`);
                this.displayLinesWithBuffer(lines, buffer_transcription, buffer_diarization, buffer_translation, status);
            }
            // シンプルなtext/transcriptフィールドがある場合（後方互換性）
            else if (text !== undefined && text !== null && text.trim() !== '') {
                const isFinal = is_final || final || false;
                this.displayTranscript({ text: text }, isFinal);
            } else if (transcript !== undefined && transcript !== null && transcript.trim() !== '') {
                const isFinal = is_final || false;
                this.displayTranscript({ text: transcript }, isFinal);
            } else {
                // その他の形式のメッセージ（デバッグ用）
                console.log('未処理のメッセージ形式:', data);
            }
        }
    }

    displayTranscript(data, isFinal = false) {
        const text = data.text || data.transcript || '';

        if (text && text.trim()) {
            // プレースホルダーを削除
            const placeholder = this.transcript.querySelector('.transcript-placeholder');
            if (placeholder) {
                placeholder.remove();
            }

            // 最後の行が部分的な結果の場合は更新、そうでなければ新しい行を追加
            const lastLine = this.transcript.lastElementChild;
            if (lastLine && lastLine.classList.contains('transcript-line-partial')) {
                // 部分的な結果を更新
                lastLine.textContent = text;
                if (isFinal) {
                    lastLine.classList.remove('transcript-line-partial');
                    lastLine.classList.add('transcript-line-final');
                }
            } else if (isFinal || !lastLine || !lastLine.classList.contains('transcript-line-partial')) {
                // 確定した結果、または新しい行を追加
                const transcriptLine = document.createElement('div');
                transcriptLine.className = isFinal ? 'transcript-line transcript-line-final' : 'transcript-line transcript-line-partial';
                transcriptLine.textContent = text;
                this.transcript.appendChild(transcriptLine);
            }

            // 自動スクロール
            this.transcript.scrollTop = this.transcript.scrollHeight;
        }
    }

    displayLinesWithBuffer(lines, buffer_transcription, buffer_diarization, buffer_translation, status) {
        // 「音声検出なし」状態の処理
        if (status === 'no_audio_detected') {
            this.transcript.innerHTML = '<div class="transcript-placeholder" style="color: #999; font-style: italic;">音声が検出されていません...</div>';
            return;
        }

        // プレースホルダーを削除
        const placeholder = this.transcript.querySelector('.transcript-placeholder');
        if (placeholder) {
            placeholder.remove();
        }

        // 全ての行を表示
        this.transcript.innerHTML = '';

        lines.forEach((line, idx) => {
            const lineDiv = document.createElement('div');
            lineDiv.className = 'transcript-line transcript-line-final';

            let content = '';

            // 話者情報の表示
            if (line.speaker && line.speaker !== 0 && line.speaker !== -2) {
                content += `<span style="color: #667eea; font-weight: 600;">話者 ${line.speaker}:</span> `;
            }

            // タイムスタンプの表示
            if (line.start !== undefined && line.end !== undefined) {
                content += `<span style="color: #999; font-size: 0.9em;">[${line.start.toFixed(1)}s - ${line.end.toFixed(1)}s]</span> `;
            }

            // テキスト
            content += (line.text || '');

            // 最後の行にバッファを追加
            if (idx === lines.length - 1) {
                if (buffer_diarization) {
                    content += `<span style="color: #999; font-style: italic;"> ${buffer_diarization}</span>`;
                }
                if (buffer_transcription) {
                    content += `<span style="color: #999; font-style: italic;"> ${buffer_transcription}</span>`;
                }
            }

            // 翻訳がある場合
            if (line.translation) {
                content += `<div style="color: #764ba2; margin-top: 5px; font-size: 0.95em;">翻訳: ${line.translation}</div>`;
            }

            // 最後の行に翻訳バッファを追加
            if (idx === lines.length - 1 && buffer_translation) {
                content += `<div style="color: #999; margin-top: 5px; font-size: 0.95em; font-style: italic;">翻訳: ${buffer_translation}</div>`;
            }

            lineDiv.innerHTML = content;
            this.transcript.appendChild(lineDiv);
        });

        // 自動スクロール
        this.transcript.scrollTop = this.transcript.scrollHeight;
    }

    clearTranscript() {
        this.transcript.innerHTML = '<div class="transcript-placeholder">文字起こしを開始すると、ここに結果が表示されます</div>';
    }

    cleanupAudioContext() {
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.microphone) {
            this.microphone.disconnect();
            this.microphone = null;
        }
        if (this.recorderWorker) {
            this.recorderWorker.terminate();
            this.recorderWorker = null;
        }
        // AudioContextは再利用せずに閉じる
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(console.error);
            this.audioContext = null;
        }
    }

    stopRecording() {
        this.isRecording = false;
        this.stopTimer();
        this.updateButton(false);
        this.updateStatus('停止中...', 'stopping');

        // MediaRecorderを停止
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try {
                this.mediaRecorder.stop();
            } catch (e) {
                console.warn('MediaRecorder停止エラー:', e);
            }
            this.mediaRecorder = null;
        }

        // AudioWorklet/Workerの停止
        this.cleanupAudioContext();

        // ストリームを停止
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        // 最後の空のBlobを送信して処理を完了させる（公式実装に合わせる）
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const emptyBlob = new Blob([], { type: 'audio/webm' });
            this.ws.send(emptyBlob);
            this.updateStatus('録音を停止しました。最終処理中...', 'stopping');
        }

        // WebSocketは接続を維持（次回の録音に備える）
        // this.ws.close(); // コメントアウト

        this.updateStatus('準備完了', 'info');
    }

    updateButton(recording) {
        if (recording) {
            this.recordButton.classList.add('recording');
            this.recordButton.querySelector('.button-text').textContent = '文字起こし停止';
            this.recordButton.querySelector('.button-icon').textContent = '⏹';
        } else {
            this.recordButton.classList.remove('recording');
            this.recordButton.querySelector('.button-text').textContent = '文字起こし開始';
            this.recordButton.querySelector('.button-icon').textContent = '🎤';
        }
    }

    startTimer() {
        this.timerInterval = setInterval(() => {
            if (this.startTime) {
                const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                this.timer.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            }
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        this.timer.textContent = '00:00';
    }

    updateStatus(message, type = 'info') {
        this.status.textContent = message;
        this.status.className = `status ${type}`;
    }
}

// アプリケーションの初期化
document.addEventListener('DOMContentLoaded', () => {
    new TranscriptionClient();
});
