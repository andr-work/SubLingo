const { execSync, spawn } = require('child_process');

// Windows環境でターミナルを開かないようにする設定
const execOptions = {
  stdio: 'pipe',
  shell: true,
  windowsHide: true
};

function checkGPU() {
  try {
    // nvidia-smiコマンドでGPUの存在をチェック
    execSync('nvidia-smi', { ...execOptions, stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function imageExists(imageName) {
  try {
    execSync(`docker image inspect ${imageName}`, { ...execOptions, stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function containerExists(containerName) {
  try {
    const result = execSync(`docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`, {
      ...execOptions,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return result.trim() === containerName;
  } catch (error) {
    return false;
  }
}

function containerIsRunning(containerName) {
  try {
    const result = execSync(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`, {
      ...execOptions,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return result.trim() === containerName;
  } catch (error) {
    return false;
  }
}

function stopAndRemoveContainer(containerName) {
  try {
    execSync(`docker stop ${containerName}`, { ...execOptions, stdio: 'ignore' });
  } catch (error) {
    // コンテナが存在しない、または既に停止している場合は無視
  }
  try {
    execSync(`docker rm ${containerName}`, { ...execOptions, stdio: 'ignore' });
  } catch (error) {
    // コンテナが存在しない場合は無視
  }
}

function waitForContainer(containerName, maxWaitTime = 30000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(() => {
      try {
        const result = execSync(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`, {
          ...execOptions,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        if (result.trim() === containerName) {
          clearInterval(checkInterval);
          resolve();
        } else if (Date.now() - startTime > maxWaitTime) {
          clearInterval(checkInterval);
          reject(new Error(`Container ${containerName} did not start within ${maxWaitTime}ms`));
        }
      } catch (error) {
        // エラーは無視して続行
        if (Date.now() - startTime > maxWaitTime) {
          clearInterval(checkInterval);
          reject(new Error(`Container ${containerName} did not start within ${maxWaitTime}ms`));
        }
      }
    }, 1000); // チェック間隔を1秒に延長
  });
}

function runDocker(detached = false) {
  const hasGPU = checkGPU();
  const containerName = hasGPU ? 'wlk' : 'wlk-cpu';
  const imageName = hasGPU ? 'wlk' : 'wlk:cpu';
  const dockerfile = hasGPU ? 'Dockerfile' : 'Dockerfile.cpu';

  // 既にコンテナが起動している場合は何もしない
  if (containerIsRunning(containerName)) {
    console.log(`${containerName} container is already running.`);
    return;
  }

  // 既にコンテナが存在するが停止している場合は再開 (削除しない)
  if (containerExists(containerName)) {
    console.log(`Resuming existing ${containerName} container...`);
    try {
      execSync(`docker start ${containerName}`, { ...execOptions, stdio: 'ignore' });

      if (detached) {
        waitForContainer(containerName).then(() => {
          console.log(`${containerName} container is ready.`);
        }).catch((error) => {
          console.error(`Failed to start ${containerName}:`, error.message);
        });
      } else {
        console.log(`${containerName} container started.`);
      }
      return; // 再利用したので終了
    } catch (e) {
      console.error("Failed to restart container, removing and recreating...", e);
      stopAndRemoveContainer(containerName);
    }
  }

  if (hasGPU) {
    if (!imageExists('wlk')) {
      console.log('GPU image (wlk) not found. Building first...');
      execSync('docker build -t wlk .', { ...execOptions, stdio: detached ? 'pipe' : 'inherit' });
    }
    console.log('GPU detected. Running with GPU support...');
  } else {
    if (!imageExists('wlk:cpu')) {
      console.log('CPU image (wlk:cpu) not found. Building first...');
      execSync('docker build -t wlk:cpu -f Dockerfile.cpu .', { ...execOptions, stdio: detached ? 'pipe' : 'inherit' });
    }
    console.log('No GPU detected. Running CPU version...');
  }

  // ホスト側のキャッシュディレクトリを準備
  const homedir = require('os').homedir();
  const path = require('path');
  const fs = require('fs');
  const cacheDir = path.join(homedir, 'wlk_cache');

  if (!fs.existsSync(cacheDir)) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      console.log(`Created cache directory: ${cacheDir}`);
    } catch (e) {
      console.error(`Failed to create cache directory: ${e.message}`);
    }
  }

  const dockerRunCmd = hasGPU
    ? `docker run -d --gpus all -p 8000:8000 -v "${cacheDir}:/root/.cache/huggingface/hub" --name wlk wlk`
    : `docker run -d -p 8000:8000 -v "${cacheDir}:/root/.cache/huggingface/hub" --name wlk-cpu wlk:cpu`;

  if (detached) {
    execSync(dockerRunCmd, { ...execOptions, stdio: 'pipe' });
    console.log(`Starting ${containerName} container...`);
    // コンテナの起動を待つ
    waitForContainer(containerName).then(() => {
      console.log(`${containerName} container is ready.`);
    }).catch((error) => {
      console.error(`Failed to start ${containerName}:`, error.message);
    });
  } else {
    execSync(dockerRunCmd.replace('-d ', ''), { ...execOptions, stdio: 'inherit' });
  }
}

// コマンドライン引数で--detachedまたは-dが指定された場合はバックグラウンド実行
const detached = process.argv.includes('--detached') || process.argv.includes('-d');
runDocker(detached);

