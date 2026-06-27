import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import * as tf from "@tensorflow/tfjs-node"; // <-- استخدم import * as tf

const app = express();
app.use(cors());
app.use(bodyParser.json());

let model = null;

(async () => {
  try {
    model = await tf.loadLayersModel("file://server/model/model.json");
    console.log("Model loaded");
  } catch (err) {
    console.warn("Model not loaded, fallback active:", err.message);
  }
})();

function predictWithModel(state) {
  if (!model) return null;
  const input = tf.tensor([state]);
  const output = model.predict(input);
  const action = output.argMax(-1).dataSync()[0];
  return action;
}

function fallbackPolicy() {
  return Math.floor(Math.random() * 3);
}

app.post("/api/rl/action", (req, res) => {
  const state = req.body.state;
  if (!Array.isArray(state)) return res.status(400).json({ error: "state must be array" });

  const modelAction = predictWithModel(state);
  const action = modelAction === null ? fallbackPolicy() : modelAction;
  res.json({ action });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`RL API running on port ${PORT}`));
