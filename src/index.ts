import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import toolsRouter from "./routes/tools";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

app.get("/", (req, res) => {
  res.json({ message: "AI Receptionist Backend Running" });
});

app.get("/test", (req, res) => {
  res.json({ success: true });
});

app.use("/tool", toolsRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
