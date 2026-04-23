const express = require("express");
const cors = require("cors");
const app = express();

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

// DEBUG: log all env var keys so we can see what Railway provides
console.log("ENV KEYS:", Object.keys(process.env).filter(k => !k.startsWith("npm")));
console.log("FB_SERVICE_KEY present:", !!process.env.FB_SERVICE_KEY);
console.log("FB_SERVICE_KEY length:", process.env.FB_SERVICE_KEY?.length);
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(`${process.env.STRIPE_KEY}`);

// middleware
app.use(cors({
  origin: "*"
}));
app.use(express.json());


const crypto = require("crypto");

const admin = require("firebase-admin");

if (!process.env.FB_SERVICE_KEY) {
  console.error("FATAL: FB_SERVICE_KEY env var is missing or empty!");
  process.exit(1);
}

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);

const serviceAccount = JSON.parse(decoded);

// 🔥 FIX newline issue
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyFBToken = async (req, res, next) => {
  console.log("header in middleware", req.headers?.authorization);

  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "Unauthorized access!" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in token- ", decoded);
    req.decoded_mail = decoded.email;
    console.log("🔐 Decoded email:", req.decoded_mail);
    next();
  } catch (err) {
    console.error("❌ Token verification failed:", err.message); // Add error logging
    return res.status(401).send({ message: "Unauthorized access!" });
  }
};

// connection string MongoDB
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.f4bf0kb.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_db");
    const userCollection = db.collection("users");
    const trackingCollection = db.collection("trackings");
    const riderCollection = db.collection("riders");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");

    // middleware- before allowing admin activity with db
    // must be used after verifyFBToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_mail;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access Denied!" });
      }

      next();
    };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status,
        createdAt: new Date(),
      };

      const result = await trackingCollection.insertOne(log);
      return result;
    };

    // user relate apis

    app.get("/users", verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.displayName = {$regex: searchText, $options: 'i'};

        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = userCollection.find(query).sort({ createdAt: -1 });

      const result = await cursor.toArray();
      return res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await userCollection.findOne({ email: email });

      if (userExists) {
        return res.send({ message: "user exists already!" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users/:id", async (req, res) => {});

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;

      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await userCollection.updateOne(query, updatedDoc);
        return res.send(result);
      },
    );

    // riders related apis

    app.get("/riders", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (district) {
        query.riderDistrict = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      console.log("Incoming query:", req.query);
      const cursor = riderCollection.find(query);
      const result = await cursor.toArray();
      return res.send(result);
    });

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status: status,
          workStatus: "Available",
        },
      };
      const result = await riderCollection.updateOne(query, updatedDoc);

      if (status === "approved") {
        const riderMail = req.body.email;
        const userQuery = { email: riderMail };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await userCollection.updateOne(
          userQuery,
          updateUser,
        );
      }

      res.send(result);
    });

    app.get("/riders/delivery-per-day", async (req, res) => {
      const email = req.query.email;

      const pipeline = [
        {
          $match: {
            riderMail: email,
          },
        },
      ];

      const result = await riderCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();

      const result = await riderCollection.insertOne(rider);
      return res.send(result);
    });

    // parcel APIS
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = {
        sort: { createdAt: -1 },
      };

      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcel/delivery-status/stats", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
          },
        },
      ];

      const result = await parcelCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderMail, deliveryStatus } = req.query;
      const query = {};
      if (riderMail) {
        query.ridermail = riderMail;
      }
      if (deliveryStatus !== "parcel-delivered") {
        // query.deliveryStatus = {$in: ['rider-arriving', 'rider-assigned']};
        query.deliveryStatus = { $nin: ["parcel-delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelCollection.find(query);
      const result = await cursor.toArray();
      return res.send(result);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderEmail, riderName, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updatedDoc = {
        $set: {
          deliveryStatus: "rider-assigned",
          riderId: riderId,
          riderName: riderName,
          ridermail: riderEmail,
        },
      };

      const result = await parcelCollection.updateOne(query, updatedDoc);

      // update rider

      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in-delivery",
        },
      };

      const riderResult = await riderCollection.updateOne(
        riderQuery,
        riderUpdatedDoc,
      );

      // log tracking
      logTracking(trackingId, "rider-assigned");
      res.send(riderResult);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      if (deliveryStatus === "parcel-delivered") {
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdatedDoc = {
          $set: {
            workStatus: "Available",
          },
        };
        const riderResult = await riderCollection.updateOne(
          riderQuery,
          riderUpdatedDoc,
        );
      }

      const result = await parcelCollection.updateOne(query, updatedDoc);

      // tracking log
      logTracking(trackingId, deliveryStatus);

      return res.send(result, deliveryStatus);
    });

    app.get("/parcel/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      console.log(req.body);
      const parcel = req.body;
      const trackingId = generateTrackingId();
      parcel.trackingId = trackingId;
      parcel.createdAt = new Date();

      // tracking logs
      logTracking(trackingId, "created");

      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    function generateTrackingId() {
      const prefix = "ZAP"; // your app name
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // 20260402
      const random = Math.random().toString(36).substring(2, 7).toUpperCase(); // e.g. X7K2P

      return `${prefix}-${date}-${random}`;
      // Result: ZAP-20260402-X7K2P
    }

    // PAYMENT related apis

    app.post("/checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              product_data: { name: paymentInfo.parcelName },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
          trackingId: paymentInfo.trackingId,
        },
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      // console.log(session);
      res.send({ url: session.url });
    });

    // payment success
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log("payment_intent:", session.payment_intent);
      console.log("payment_status:", session.payment_status);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);

      if (paymentExist) {
        return res.send({
          message: "Already exists.",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }
      const trackingId = session.metadata.trackingId;

      if (session.payment_status == "paid") {
        const id = session.metadata.parcelId;

        const query = { _id: new ObjectId(id) };

        const update = {
          $set: { paymentStatus: "paid", deliveryStatus: "pending" },
        };
        await parcelCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        const result = await paymentCollection.insertOne(payment);

        logTracking(trackingId, "pending");
        return res.send({
          success: true,
          modifyParcel: result,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentInfo: payment,
        });
      }

      res.send({ success: false });
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      console.log(req.headers);
      if (email) {
        query.customerEmail = email;

        if (email !== req.decoded_mail) {
          return res.status(403).send({ message: "Forbidden access!" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: 1 });
      const result = await cursor.toArray();
      return res.send(result);
    });

    // tracking related APIs
    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingCollection.find(query).toArray();
      return res.send(result);
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!",
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap is shifting!");
});


app.listen(port, () => {
  console.log("Server running on port", port);
});