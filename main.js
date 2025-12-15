const { app, BrowserWindow, session } = require('electron')
const { spawn } = require('child_process')
const { execSync } = require('child_process')
const http = require('http')
const path = require('path')

let dockerProcess = null
let dockerStarted = false
let loadingWindow = null
let mainWindow = null

const createLoadingWindow = () => {
    loadingWindow = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        transparent: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    })

    loadingWindow.loadFile('loading.html')
    loadingWindow.center()
    return loadingWindow
}

const createMainWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    })

    mainWindow.loadFile('index.html')

    // ローディングウィンドウを閉じる
    if (loadingWindow) {
        loadingWindow.close()
        loadingWindow = null
    }

    return mainWindow
}

const updateLoadingStatus = (message, status = '') => {
    if (loadingWindow && !loadingWindow.isDestroyed()) {
        loadingWindow.webContents.executeJavaScript(`
            document.getElementById('message').textContent = '${message}';
            document.getElementById('status').textContent = '${status}';
        `).catch(() => { })
    }
}

function checkContainerRunning() {
    try {
        const execOptions = {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            shell: true,
            windowsHide: true
        };
        const result1 = execSync('docker ps --filter "name=wlk" --format "{{.Names}}"', execOptions);
        const result2 = execSync('docker ps --filter "name=wlk-cpu" --format "{{.Names}}"', execOptions);
        return result1.trim() === 'wlk' || result2.trim() === 'wlk-cpu';
    } catch (error) {
        return false;
    }
}

const startDocker = () => {
    return new Promise((resolve, reject) => {
        // 既にコンテナが起動している場合は何もしない
        if (checkContainerRunning()) {
            console.log('Docker container is already running')
            updateLoadingStatus('Dockerコンテナは既に起動しています', '接続を確認中...')
            resolve()
            return
        }

        // 既に起動処理が実行されている場合は何もしない
        if (dockerStarted) {
            resolve()
            return
        }

        dockerStarted = true
        updateLoadingStatus('Dockerコンテナを起動しています...', '')

        const dockerRunScript = path.join(__dirname, 'docker-run.js')
        dockerProcess = spawn('node', [dockerRunScript, '--detached'], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })

        dockerProcess.stdout.on('data', (data) => {
            const message = data.toString().trim()
            console.log(`Docker: ${message}`)
            if (message.includes('container is ready') || message.includes('Running')) {
                updateLoadingStatus('Dockerコンテナが起動しました', '接続を確認中...')
            }
        })

        dockerProcess.stderr.on('data', (data) => {
            console.error(`Docker Error: ${data.toString().trim()}`)
        })

        dockerProcess.on('close', (code) => {
            if (code === 0) {
                console.log('Docker container started in background')
                resolve()
            } else {
                console.error(`Docker process exited with code ${code}`)
                reject(new Error(`Docker process exited with code ${code}`))
            }
        })

        dockerProcess.unref()
    })
}

const checkPort = (port, maxRetries = 120, delay = 2000) => {
    return new Promise((resolve, reject) => {
        let attempts = 0
        let resolved = false

        const tryConnect = () => {
            if (resolved) return

            attempts++
            if (attempts % 5 === 0 || attempts === 1) {
                updateLoadingStatus('サーバーの起動を待っています...', `試行 ${attempts}/${maxRetries}`)
            }

            let timeoutId = null
            const req = http.get(`http://localhost:${port}/`, { timeout: 3000 }, (res) => {
                // リクエストが成功したらタイムアウトをクリア
                if (timeoutId) {
                    clearTimeout(timeoutId)
                }
                req.destroy()

                // 200, 404, 405などはサーバーが起動していることを示す
                if (res.statusCode >= 200 && res.statusCode < 500) {
                    resolved = true
                    updateLoadingStatus('サーバーに接続しました', 'アプリを起動しています...')
                    resolve()
                } else {
                    if (attempts < maxRetries && !resolved) {
                        setTimeout(tryConnect, delay)
                    } else if (!resolved) {
                        reject(new Error(`Server returned status ${res.statusCode}`))
                    }
                }
            })

            req.on('error', (error) => {
                if (resolved) return

                // リクエストが失敗したらタイムアウトをクリア
                if (timeoutId) {
                    clearTimeout(timeoutId)
                }

                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                    // 接続拒否またはタイムアウトは、サーバーがまだ起動していないことを示す
                    if (attempts < maxRetries) {
                        setTimeout(tryConnect, delay)
                    } else {
                        reject(new Error(`Failed to connect after ${maxRetries} attempts: ${error.message}`))
                    }
                } else {
                    // その他のエラー
                    if (attempts < maxRetries) {
                        setTimeout(tryConnect, delay)
                    } else {
                        reject(new Error(`Failed to connect: ${error.message}`))
                    }
                }
            })

            // タイムアウトハンドラ（リクエストが3秒以内に完了しない場合）
            timeoutId = setTimeout(() => {
                if (!resolved) {
                    req.destroy()
                    if (attempts < maxRetries) {
                        setTimeout(tryConnect, delay)
                    } else {
                        reject(new Error('Connection timeout'))
                    }
                }
            }, 3000)
        }

        tryConnect()
    })
}

const checkContainerLogs = (containerName) => {
    try {
        const execOptions = {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            shell: true,
            windowsHide: true
        };
        const logs = execSync(`docker logs --tail 20 ${containerName}`, execOptions);
        // ログは表示しない（必要に応じてコメントアウト）
        // console.log(`Container ${containerName} logs:`, logs);
        return logs;
    } catch (error) {
        // エラーログも表示しない
        // console.error(`Failed to get logs for ${containerName}:`, error.message);
        return null;
    }
}

app.whenReady().then(async () => {
    // マイク権限を許可
    session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback) => {
            if (permission === 'media') {
                callback(true)
            } else {
                callback(false)
            }
        }
    )

    // ローディングウィンドウを表示
    createLoadingWindow()

    try {
        // Dockerコンテナを起動
        updateLoadingStatus('Dockerコンテナを起動しています...', '')
        await startDocker()

        // コンテナが起動した後、少し待つ（アプリケーションの初期化時間）
        updateLoadingStatus('コンテナの初期化を待っています...', '')
        await new Promise(resolve => setTimeout(resolve, 3000))

        // コンテナのログを確認（デバッグ用、通常はコメントアウト）
        // let containerName = 'wlk'
        // try {
        //     const execOptions = {
        //         encoding: 'utf8',
        //         stdio: ['ignore', 'pipe', 'ignore'],
        //         shell: true,
        //         windowsHide: true
        //     };
        //     const result1 = execSync('docker ps --filter "name=wlk" --format "{{.Names}}"', execOptions).trim()
        //     const result2 = execSync('docker ps --filter "name=wlk-cpu" --format "{{.Names}}"', execOptions).trim()
        //     containerName = result1 === 'wlk' ? 'wlk' : (result2 === 'wlk-cpu' ? 'wlk-cpu' : 'wlk')
        // } catch (error) {
        //     // エラーは無視
        // }
        // checkContainerLogs(containerName)

        // ポート8000がリッスンしているか確認（最大4分待つ）
        updateLoadingStatus('サーバーの起動を待っています...', 'モデルのロードに時間がかかる場合があります')
        await checkPort(8000, 120, 2000) // 最大4分（120回 × 2秒）

        // メインウィンドウを表示
        updateLoadingStatus('アプリを起動しています...', '')
        setTimeout(() => {
            createMainWindow()
        }, 500)

    } catch (error) {
        console.error('Failed to start application:', error)
        updateLoadingStatus('エラーが発生しました', error.message)

        // エラー時はログを確認（必要に応じてコメントアウトを解除）
        // let containerName = 'wlk'
        // try {
        //     const execOptions = {
        //         encoding: 'utf8',
        //         stdio: ['ignore', 'pipe', 'ignore'],
        //         shell: true,
        //         windowsHide: true
        //     };
        //     const result1 = execSync('docker ps --filter "name=wlk" --format "{{.Names}}"', execOptions).trim()
        //     const result2 = execSync('docker ps --filter "name=wlk-cpu" --format "{{.Names}}"', execOptions).trim()
        //     containerName = result1 === 'wlk' ? 'wlk' : (result2 === 'wlk-cpu' ? 'wlk-cpu' : 'wlk')
        // } catch (error) {
        //     // エラーは無視
        // }
        // const logs = checkContainerLogs(containerName)

        // エラー時もメインウィンドウを表示（ユーザーが手動で再試行できるように）
        setTimeout(() => {
            createMainWindow()
        }, 3000)
    }
})

const stopDockerContainers = () => {
    const execOptions = {
        stdio: 'ignore',
        shell: true,
        windowsHide: true
    };

    // 実行中のコンテナを確認して停止
    try {
        // wlkコンテナが実行中か確認
        const wlkResult = execSync('docker ps --filter "name=wlk" --format "{{.Names}}"', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            shell: true,
            windowsHide: true
        }).trim();

        if (wlkResult === 'wlk') {
            console.log('Stopping wlk container...');
            execSync('docker stop wlk', execOptions);
            console.log('wlk container stopped');
        }
    } catch (error) {
        // コンテナが存在しない、または既に停止している場合は無視
    }

    try {
        // wlk-cpuコンテナが実行中か確認
        const cpuResult = execSync('docker ps --filter "name=wlk-cpu" --format "{{.Names}}"', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            shell: true,
            windowsHide: true
        }).trim();

        if (cpuResult === 'wlk-cpu') {
            console.log('Stopping wlk-cpu container...');
            execSync('docker stop wlk-cpu', execOptions);
            console.log('wlk-cpu container stopped');
        }
    } catch (error) {
        // コンテナが存在しない、または既に停止している場合は無視
    }
}

// アプリ終了時にDockerコンテナを停止
app.on('before-quit', (event) => {
    stopDockerContainers();
})

// ウィンドウが閉じられた時にもコンテナを停止（念のため）
app.on('window-all-closed', () => {
    // macOS以外ではアプリを終了
    if (process.platform !== 'darwin') {
        stopDockerContainers();
        app.quit();
    }
})

// アプリが完全に終了する前にコンテナを停止
process.on('exit', () => {
    stopDockerContainers();
})

// シグナルを受信した時にもコンテナを停止
process.on('SIGINT', () => {
    stopDockerContainers();
    process.exit(0);
})

process.on('SIGTERM', () => {
    stopDockerContainers();
    process.exit(0);
})