cat > server/model/make_dummy_model.js <<'JS'
import * as tf from "@tensorflow/tfjs-node";

(async () => {
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 16, inputShape: [4], activation: "relu" }));
  model.add(tf.layers.dense({ units: 3, activation: "softmax" }));
  await model.save("file://server/model");
  console.log("Dummy model saved to server/model");
  process.exit(0);
})();
JS
