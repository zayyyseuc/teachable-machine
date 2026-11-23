# Lulu's Cozy Corner · Teachable Machine Pixel Pet

A pixel-art desktop companion controlled by a browser camera, a Teachable Machine image model, and a Teachable Machine pose model.

## Start

The camera cannot run directly from a `file://` page. Start a local server instead:

```bash
cd "/Users/chen/My project/teachable machine/pixel-pet-app"
python3 -m http.server 8000
```

Visit <http://localhost:8000>, click **Start Camera & Recognition**, and allow camera access.

The page loads TensorFlow.js and the Teachable Machine Image library from a CDN, so the first launch requires an internet connection.

The app intentionally pins TensorFlow.js to `1.3.1`, the shared peer dependency required by both `@teachablemachine/image@0.8.4` and `@teachablemachine/pose@0.8.6`. Loading a newer TensorFlow.js runtime alongside both libraries can make PoseNet fail at `fromPixels`.

## State mapping

| Model label | Companion state |
| --- | --- |
| `drink` | Drinking |
| `study` | Reading |
| `none` | Idle |

| Pose label | Companion state |
| --- | --- |
| `house` | Both hands raised above the head |
| `hand` | Left hand raised |
| `neutral` | Return to the current object state |

Predictions are smoothed. Object states require 72% confidence, pose states require 78%, and both must remain stable for about 0.7 seconds. An active `house` or `hand` pose temporarily takes priority over the object state; `neutral` returns Lulu to drinking, reading, or idle.

## Files

- `index.html`: page structure
- `styles.css`: pixel-art interface and state animations
- `app.js`: camera, model inference, state switching, and daily progress
- `model/`: exported Teachable Machine model
- `pose-model/`: exported Teachable Machine pose model
- `assets/pet-states.png`: original three-state pixel character atlas
- `assets/pet-pose-states.png`: original two-state pose character atlas

Daily water and study counts are stored only in this browser's `localStorage` and are never uploaded.
