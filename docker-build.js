const { execSync } = require('child_process');

function checkGPU() {
  try {
    // nvidia-smiコマンドでGPUの存在をチェック
    execSync('nvidia-smi', { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function imageExists(imageName) {
  try {
    execSync(`docker image inspect ${imageName}`, { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function buildDocker() {
  const hasGPU = checkGPU();
  
  if (hasGPU) {
    if (imageExists('wlk')) {
      console.log('GPU image (wlk) already exists. Skipping build.');
      console.log('To rebuild, run: docker build -t wlk .');
      return;
    }
    console.log('GPU detected. Building with Dockerfile (GPU support)...');
    execSync('docker build -t wlk .', { stdio: 'inherit' });
  } else {
    if (imageExists('wlk:cpu')) {
      console.log('CPU image (wlk:cpu) already exists. Skipping build.');
      console.log('To rebuild, run: docker build -t wlk:cpu -f Dockerfile.cpu .');
      return;
    }
    console.log('No GPU detected. Building with Dockerfile.cpu...');
    execSync('docker build -t wlk:cpu -f Dockerfile.cpu .', { stdio: 'inherit' });
  }
}

buildDocker();

