# SubLingo
Learn English with real-time subtitles.

Use [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit?tab=readme-ov-file) to transcribe audio in real-time.

Can use on-site(face to face meeting) or online(zoom, teams, etc).

In online case, get audio from [VB-Audio Virtual Cable](https://vb-audio.com/Cable/).


```
uv venv

uv pip install whisperlivekit

uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu129
```