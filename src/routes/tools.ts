import { Router } from "express";
import fs from "fs";
import path from "path";
import services from "../knowledge/services.json";
const router = Router();

const filePath = path.join(__dirname, "../data/booking_requests.json");
router.post("/create-booking-request", async (req, res) => {
  try {
    const { caller_name, phone, requested_service, preferred_times } = req.body;

    const newRequest = {
      id: Date.now(),
      caller_name,
      phone,
      requested_service,
      preferred_times,
      created_at: new Date().toISOString()
    };

    console.log("BOOKING SAVED:", newRequest);

    // send to n8n
const webhookUrl = process.env.N8N_BOOKING_WEBHOOK_URL;

if (!webhookUrl) {
  throw new Error("N8N_BOOKING_WEBHOOK_URL is not set");
}

await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(newRequest)
    });

    console.log("SENT TO N8N");

    // ✅ DAS IST DER WICHTIGE TEIL
    return res.json({
      success: true,
      message: "Booking request saved",
      data: newRequest
    });

  } catch (error) {
    console.error("ERROR:", error);

    return res.json({
      success: false,
      message: "Error saving booking request"
    });
  }
});
router.post("/search-services", (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== "string") {
    return res.status(400).json({
      success: false,
      message: "Missing required field: query"
    });
  }
const lowerQuery = query.toLowerCase().trim();

const genericServiceQueries = [
  "what services do you offer",
  "what do you offer",
  "what treatments do you offer",
  "what treatments do you have",
  "what services do you have",
  "services",
  "treatments",
  "what can you help with"
];

const shouldReturnAllServices = genericServiceQueries.some((phrase) =>
  lowerQuery.includes(phrase)
);

const matches = shouldReturnAllServices
  ? (services as any[])
  : (services as any[]).filter((service) => {
      return (
        service.name.toLowerCase().includes(lowerQuery) ||
        service.short_description.toLowerCase().includes(lowerQuery) ||
        service.keywords.some((keyword: string) =>
          lowerQuery.includes(keyword.toLowerCase()) ||
          keyword.toLowerCase().includes(lowerQuery)
        )
      );
    });

const serviceNames = matches.map((service: any) => service.name);

let spokenSummary = "I couldn't find any matching services.";

if (serviceNames.length === 1) {
  spokenSummary = `We offer ${serviceNames[0]}.`;
} else if (serviceNames.length === 2) {
  spokenSummary = `We offer ${serviceNames[0]} and ${serviceNames[1]}.`;
} else if (serviceNames.length > 2) {
  const last = serviceNames[serviceNames.length - 1];
  const firstPart = serviceNames.slice(0, -1).join(", ");
  spokenSummary = `We offer ${firstPart}, and ${last}.`;
}

return res.json({
  success: true,
  count: matches.length,
  matches,
  service_names: serviceNames,
  spoken_summary: spokenSummary
});
});
router.get("/clinic-info", (req, res) => {
  return res.json({
    success: true,
    clinic: {
      name: "Amityville Acupuncture",
      address: "Amityville, NY",
      phone: "+1 XXX XXX XXXX",
      website: "https://www.amityvillewellness.com",
      hours: {
        monday: "9am - 6pm",
        tuesday: "9am - 6pm",
        wednesday: "9am - 6pm",
        thursday: "9am - 6pm",
        friday: "9am - 5pm",
        saturday: "by appointment",
        sunday: "closed"
      }
    }
  });
});
router.post("/create-callback-request", (req, res) => {
  const { caller_name, phone, reason } = req.body;

  if (!caller_name || !phone) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: caller_name and phone"
    });
  }

  const callbackFilePath = path.join(__dirname, "../data/callback_requests.json");

  const newCallbackRequest = {
    id: Date.now(),
    caller_name,
    phone,
    reason: reason || "No reason provided",
    created_at: new Date().toISOString()
  };

  let data = [];
  try {
    const fileContent = fs.readFileSync(callbackFilePath, "utf-8");
    data = JSON.parse(fileContent);
  } catch (err) {
    data = [];
  }

  data.push(newCallbackRequest);

  fs.writeFileSync(callbackFilePath, JSON.stringify(data, null, 2));

  console.log("CALLBACK SAVED:", newCallbackRequest);

  return res.json({
    success: true,
    message: "Callback request saved",
    data: newCallbackRequest
  });
});
export default router;
