const MODEL_BASE = "./model/";
const POSE_MODEL_BASE = "./pose-model/";
const CONFIDENCE_THRESHOLD = 0.72;
const POSE_CONFIDENCE_THRESHOLD = 0.78;
const STABLE_FOR_MS = 700;
const EMA_WEIGHT = 0.38;

const stateCopy = {
  idle: {
    label: "Taking It Easy",
    icon: "☘",
    speech: "Let's take it easy today.",
    aria: "Lulu is idle",
  },
  drink: {
    label: "Drinking With You",
    icon: "◆",
    speech: "Cheers! Take a nice, slow sip.",
    aria: "Lulu is drinking water",
  },
  study: {
    label: "Quiet Reading Time",
    icon: "▤",
    speech: "Open a page and let's focus together.",
    aria: "Lulu is reading",
  },
  house: {
    label: "House Pose",
    icon: "⌂",
    speech: "A tiny roof! Both hands are up.",
    aria: "Lulu is holding both hands above her head",
  },
  hand: {
    label: "Left Hand Up",
    icon: "✦",
    speech: "Hello! I can see your left hand.",
    aria: "Lulu is raising her left hand",
  },
};

const classToState = { drink: "drink", study: "study", none: "idle" };
const poseClassToState = { house: "house", hand: "hand", neutral: null };
const scoreElements = {
  drink: { bar: document.querySelector("#drinkBar"), text: document.querySelector("#drinkScore") },
  study: { bar: document.querySelector("#studyBar"), text: document.querySelector("#studyScore") },
  none: { bar: document.querySelector("#noneBar"), text: document.querySelector("#noneScore") },
};
const poseScoreElements = {
  house: { bar: document.querySelector("#houseBar"), text: document.querySelector("#houseScore") },
  hand: { bar: document.querySelector("#handBar"), text: document.querySelector("#handScore") },
  neutral: { bar: document.querySelector("#neutralBar"), text: document.querySelector("#neutralScore") },
};

const modelStatus = document.querySelector("#modelStatus");
const cameraButton = document.querySelector("#cameraButton");
const cameraFrame = document.querySelector("#cameraFrame");
const cameraPlaceholder = document.querySelector("#cameraPlaceholder");
const petStage = document.querySelector("#petStage");
const petSprite = document.querySelector(".pet-sprite");
const speechBubble = document.querySelector("#speechBubble");
const stateLabel = document.querySelector("#stateLabel");
const stateIcon = document.querySelector("#stateIcon");
const previewButtons = [...document.querySelectorAll(".preview-button")];
const waterCount = document.querySelector("#waterCount");
const studyCount = document.querySelector("#studyCount");
const waterProgress = document.querySelector("#waterProgress");
const studyProgress = document.querySelector("#studyProgress");
const resetButton = document.querySelector("#resetButton");

let model = null;
let poseModel = null;
let webcam = null;
let running = false;
let objectRecognitionActive = true;
let poseRecognitionActive = true;
let currentState = "idle";
let objectState = "idle";
let poseState = null;
let pendingClass = "none";
let pendingSince = performance.now();
let pendingPoseClass = "neutral";
let pendingPoseSince = performance.now();
let smoothedScores = { drink: 0, study: 0, none: 0 };
let smoothedPoseScores = { house: 0, hand: 0, neutral: 0 };
let latestPredictionAt = 0;
let lastRecordedAt = { drink: 0, study: 0 };
let journal = loadJournal();

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function loadJournal() {
  try {
    const saved = JSON.parse(localStorage.getItem("lulu-journal") || "null");
    if (saved?.date === todayKey()) {
      return { date: saved.date, water: Number(saved.water) || 0, study: Number(saved.study) || 0 };
    }
  } catch (_) {
    // A fresh journal is safer than blocking the classifier for corrupt local data.
  }
  return { date: todayKey(), water: 0, study: 0 };
}

function saveJournal() {
  localStorage.setItem("lulu-journal", JSON.stringify(journal));
}

function buildProgress(element, total) {
  element.replaceChildren();
  for (let i = 0; i < total; i += 1) element.append(document.createElement("i"));
}

function renderJournal() {
  waterCount.textContent = journal.water;
  studyCount.textContent = journal.study;
  [...waterProgress.children].forEach((segment, index) => segment.classList.toggle("filled", index < journal.water));
  [...studyProgress.children].forEach((segment, index) => segment.classList.toggle("filled", index < journal.study));
}

function recordHabit(state) {
  const now = Date.now();
  if (state === "drink" && now - lastRecordedAt.drink > 12_000) {
    journal.water = Math.min(6, journal.water + 1);
    lastRecordedAt.drink = now;
  }
  if (state === "study" && now - lastRecordedAt.study > 12_000) {
    journal.study = Math.min(3, journal.study + 1);
    lastRecordedAt.study = now;
  }
  saveJournal();
  renderJournal();
}

function setState(state, { record = true } = {}) {
  if (!stateCopy[state]) state = "idle";
  const changed = currentState !== state;
  currentState = state;
  petStage.dataset.state = state;
  stateLabel.textContent = stateCopy[state].label;
  stateIcon.textContent = stateCopy[state].icon;
  speechBubble.textContent = stateCopy[state].speech;
  petSprite.setAttribute("aria-label", stateCopy[state].aria);
  previewButtons.forEach((button) => button.classList.toggle("active", button.dataset.preview === state));
  if (changed && record && (state === "drink" || state === "study")) recordHabit(state);
}

function updateStatus(message, status = "waiting") {
  modelStatus.dataset.status = status;
  modelStatus.querySelector("span:last-child").textContent = message;
}

function updateMeters(scores, elements = scoreElements) {
  Object.entries(elements).forEach(([label, element]) => {
    const percentage = Math.round((scores[label] || 0) * 100);
    element.bar.style.width = `${percentage}%`;
    element.text.textContent = `${percentage}%`;
  });
}

function chooseStableState(scores, now) {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let candidate = ranked[0][0];
  if (ranked[0][1] < CONFIDENCE_THRESHOLD) candidate = "none";

  if (candidate !== pendingClass) {
    pendingClass = candidate;
    pendingSince = now;
    return;
  }

  if (now - pendingSince >= STABLE_FOR_MS) {
    objectState = classToState[candidate] || "idle";
    if (!poseState) setState(objectState);
  }
}

function chooseStablePose(scores, now) {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let candidate = ranked[0][0];
  if (ranked[0][1] < POSE_CONFIDENCE_THRESHOLD) candidate = "neutral";

  if (candidate !== pendingPoseClass) {
    pendingPoseClass = candidate;
    pendingPoseSince = now;
    return;
  }

  if (now - pendingPoseSince >= STABLE_FOR_MS) {
    const nextPoseState = poseClassToState[candidate] || null;
    if (poseState !== nextPoseState) {
      poseState = nextPoseState;
      setState(poseState || objectState, { record: !poseState });
    }
  }
}

async function predictObject(now) {
  const prediction = await model.predict(webcam.canvas);
  const raw = { drink: 0, study: 0, none: 0 };
  prediction.forEach(({ className, probability }) => {
    const label = className.trim().toLowerCase();
    if (label in raw) raw[label] = probability;
  });

  Object.keys(raw).forEach((label) => {
    smoothedScores[label] = smoothedScores[label] * (1 - EMA_WEIGHT) + raw[label] * EMA_WEIGHT;
  });
  updateMeters(smoothedScores);
  chooseStableState(smoothedScores, now);
}

async function predictPose(now) {
  const { posenetOutput } = await poseModel.estimatePose(webcam.canvas);
  const posePrediction = await poseModel.predict(posenetOutput);
  const rawPose = { house: 0, hand: 0, neutral: 0 };
  posePrediction.forEach(({ className, probability }) => {
    const label = className.trim().toLowerCase();
    if (label in rawPose) rawPose[label] = probability;
  });

  Object.keys(rawPose).forEach((label) => {
    smoothedPoseScores[label] = smoothedPoseScores[label] * (1 - EMA_WEIGHT) + rawPose[label] * EMA_WEIGHT;
  });
  updateMeters(smoothedPoseScores, poseScoreElements);
  chooseStablePose(smoothedPoseScores, now);
}

async function predict(now) {
  if (!model || !poseModel || !webcam || now - latestPredictionAt < 170) return;
  latestPredictionAt = now;

  if (objectRecognitionActive) {
    try {
      await predictObject(now);
    } catch (error) {
      objectRecognitionActive = false;
      console.error("Object recognition failed", error);
    }
  }

  if (poseRecognitionActive) {
    try {
      await predictPose(now);
    } catch (error) {
      poseRecognitionActive = false;
      poseState = null;
      console.error("Pose recognition failed", error);
    }
  }

  if (!objectRecognitionActive && !poseRecognitionActive) {
    throw new Error("Both recognition models stopped");
  }
  if (!objectRecognitionActive) updateStatus("Pose is live · object model unavailable", "error");
  else if (!poseRecognitionActive) updateStatus("Object model is live · pose unavailable", "error");
}

async function loop(now) {
  if (!running) return;
  webcam.update();
  try {
    await predict(now);
  } catch (error) {
    console.error(error);
    updateStatus("Recognition stopped — restart to retry", "error");
    running = false;
    cameraButton.disabled = false;
    cameraButton.textContent = "Restart Recognition";
    return;
  }
  requestAnimationFrame(loop);
}

async function startCamera() {
  if (running) return;
  if (location.protocol === "file:") {
    updateStatus("Please open this page through localhost", "error");
    cameraButton.textContent = "Localhost Required";
    return;
  }

  cameraButton.disabled = true;
  cameraButton.textContent = "Loading Model…";
  updateStatus("Loading Teachable Machine", "waiting");

  try {
    if (!window.tmImage || !window.tmPose) throw new Error("Teachable Machine libraries did not load");
    if (!model) {
      model = await tmImage.load(`${MODEL_BASE}model.json`, `${MODEL_BASE}metadata.json`);
    }
    if (!poseModel) {
      poseModel = await tmPose.load(`${POSE_MODEL_BASE}model.json`, `${POSE_MODEL_BASE}metadata.json`);
    }
    if (!webcam) {
      webcam = new tmImage.Webcam(320, 240, true);
      await webcam.setup({ facingMode: "user" });
      cameraPlaceholder.remove();
      cameraFrame.prepend(webcam.canvas);
    }
    await webcam.play();
    objectRecognitionActive = true;
    poseRecognitionActive = true;
    running = true;
    cameraButton.textContent = "Recognition Running";
    updateStatus("Object + pose recognition is live", "live");
    requestAnimationFrame(loop);
  } catch (error) {
    console.error(error);
    cameraButton.disabled = false;
    cameraButton.textContent = "Try Again";
    updateStatus("Could not open the camera or model", "error");
    speechBubble.textContent = "I can't see anything — please check your camera permission.";
  }
}

cameraButton.addEventListener("click", startCamera);
previewButtons.forEach((button) => {
  button.addEventListener("click", () => setState(button.dataset.preview, { record: false }));
});
resetButton.addEventListener("click", () => {
  journal = { date: todayKey(), water: 0, study: 0 };
  saveJournal();
  renderJournal();
});

window.addEventListener("beforeunload", () => {
  if (webcam) webcam.stop();
});

buildProgress(waterProgress, 6);
buildProgress(studyProgress, 3);
renderJournal();
setState("idle", { record: false });
