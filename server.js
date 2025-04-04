const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const schedule = require('node-schedule');  // For scheduling reminders
require('dotenv').config();
const { exec } = require('child_process'); 
const https = require('https');
const fs = require('fs');


const sslOptions = {
  key: fs.readFileSync('ssl/key.pem'),
  cert: fs.readFileSync('ssl/cert.pem'),
};
// Twilio configuration
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

// Models
const User = require('./models/User');  // Assuming you have a User model defined


// Express app setup
const app = express();
const port = 5000;

// Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: '0000',
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,      
    secure: true,        
    maxAge: 1000 * 60 * 60 * 24  
  }
}));


// MongoDB connection
mongoose.connect('mongodb://localhost:27017/issueboard', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 50000,
}).then(async () => {
  console.log("Connected to MongoDB");

  // Schedule reminders for existing medicines
  try {
    const existingMedicines = await Medicine.find();
    existingMedicines.forEach((medicine) => {
      // Assuming you have user data associated with each medicine
      User.findById(medicine.user)
        .then((user) => {
          if (user && user.phonenumber) {
            scheduleMedicineReminder(medicine, user.phonenumber);
          } else {
            console.warn(`User or phone number not found for medicine: ${medicine.name}`);
          }
        })
        .catch((err) => {
          console.error(`Error fetching user for medicine ${medicine.name}:`, err);
        });
    });
    console.log("Reminders scheduled for existing medicines.");
  } catch (error) {
    console.error("Error scheduling reminders for existing medicines:", error);
  }
}).catch((error) => {
  console.error("MongoDB connection error:", error);
});


// Serve the index.html file for the root route
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));  // Ensure the correct path is provided to the HTML file
});

// Serve static files like CSS, JS, images
app.use(express.static(__dirname));

// Helper function to get day of the week
function getDayOfWeek(dayName) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days.indexOf(dayName);
}

// Send SMS reminder
async function sendReminder(medicine, phoneNumber) {
  const message = `Reminder: It's time to take your medicine: ${medicine.name} (${medicine.dose}).`;

  try {
    await client.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: phoneNumber
    });
    console.log(`Reminder sent for ${medicine.name}`);
  } catch (error) {
    console.error('Error sending reminder:', error);
  }
}

// Schedule medicine reminder
// Schedule medicine reminder
function scheduleMedicineReminder(medicine, phoneNumber) {
  if (!phoneNumber) {
    throw new Error('Phone number is required to schedule reminders.');
  }

  // Format the phone number to include +91
  if (!phoneNumber.startsWith('+91')) {
    phoneNumber = `+91 ${phoneNumber}`;
  }
  const now = new Date();

  medicine.when.forEach(time => {
    // Set the time for the reminder
    const reminderBaseTime = new Date(now);
    if (time === 'Morning') {
      reminderBaseTime.setHours(8, 0, 0); // 6:30 AM
    } else if (time === 'Afternoon') {
      reminderBaseTime.setHours(13, 0, 0); // 2:00 PM
    } else if (time === 'Night') {
      reminderBaseTime.setHours(22, 4, 0); // 8:30 PM
    }

    if (medicine.frequency === 'Daily') {
      // Daily reminders
      const dailyJob = schedule.scheduleJob({ hour: reminderBaseTime.getHours(), minute: reminderBaseTime.getMinutes() }, () => {
        sendReminder(medicine, phoneNumber);
      });
      console.log(`Daily reminder scheduled for ${medicine.name}`);
    } else if (medicine.frequency === 'Every Other Day') {
      // Reminders every other day
      let reminderTime = new Date(reminderBaseTime);
      reminderTime.setDate(now.getDate() + 1 + (now.getDate() % 2 === 0 ? 0 : 1)); // Skip one day
      schedule.scheduleJob(reminderTime, function scheduleNextReminder() {
        sendReminder(medicine, phoneNumber);
        // Reschedule for two days later
        reminderTime.setDate(reminderTime.getDate() + 2);
        schedule.scheduleJob(reminderTime, scheduleNextReminder);
      });
      console.log(`Every other day reminder scheduled for ${medicine.name}`);
    } else if (medicine.frequency === 'Custom') {
      // Custom reminders on specific days
      medicine.days.forEach(day => {
        const dayOfWeek = getDayOfWeek(day);

        // Schedule reminders for every week on the specified days
        const customJob = schedule.scheduleJob({ dayOfWeek, hour: reminderBaseTime.getHours(), minute: reminderBaseTime.getMinutes() }, () => {
          sendReminder(medicine, phoneNumber);
        });

        console.log(`Custom reminder scheduled for ${medicine.name} on ${day} at ${reminderBaseTime.toTimeString()}`);
      });
    }
  });
}


// Routes (server.js)

// Routes (server.js)
app.post('/signup', async (req, res) => {
  try {
    const { username, phonenumber, email, password, role, adminAccessCode } = req.body;

    if (!username || !phonenumber || !email || !password || !role) {
      return res.status(400).send("All fields are required");
    }

    // Validate admin access code if role is admin
    if (role === 'admin' && adminAccessCode !== '0000') {
      return res.status(400).send("Invalid Admin Access Code");
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).send("User already exists");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, phonenumber, email, password: hashedPassword, role, adminAccessCode });
    await newUser.save();

    res.status(201).send("User registered successfully");
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).send("Server error");
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).send("User not found");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).send("Invalid credentials");
    }

    req.session.userId = user._id;
    req.session.userphonenumber = user.phonenumber;
    req.session.userRole = user.role;

    res.status(200).json({ message: "Login successful", role: user.role });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Server error");
  }
});

// Fetch user profile data
app.get('/userprofile', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).send("Unauthorized");
    }

    const user = await User.findById(req.session.userId).select('username phonenumber email');
    if (!user) {
      return res.status(404).send("User not found");
    }

    res.status(200).json(user);
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).send("Server error");
  }
});
const ReportSchema = new mongoose.Schema({
  title: String,
  description: String,
  location: String,
  category: String,
  status: {
    type: String,
    enum: ['Pending', 'Resolved'],  // Only allow 'Pending' status
    default: 'Pending'  // Default to 'Pending'
},
  createdAt: { type: Date, default: Date.now }
});
const Report = mongoose.model('Report', ReportSchema);


// Fetch user profile
app.get('/userprofile', async (req, res) => {
  if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
      const user = await User.findById(req.session.userId);
      res.json({ username: user.username, email: user.email });
  } catch (err) {
      res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});
app.get('/reports', async (req, res) => {
  try {
    let query = {};

    // Only add filters to the query if they are present
    if (req.query.category) {
      query.category = req.query.category;
    }

    if (req.query.status) {
      query.status = req.query.status;
    }

    console.log('Query:', query);  // Debugging the query object to see the filter

    // Assuming you are using MongoDB
    const reports = await Report.find(query);

    res.json(reports);  // Send the filtered reports as the response
  } catch (err) {
    console.error('Error fetching reports:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});



// Add a new report
app.post('/addreport', async (req, res) => {
  if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
      const { title, description, location, category } = req.body;

      const report = new Report({
          title,
          description,
          location,
          category,
          status: 'Pending'  // Default status is always 'Pending' when adding a new report
      });

      await report.save();
      res.json({ success: true, message: 'Report added successfully' });
  } catch (err) {
      res.status(500).json({ error: 'Failed to add report' });
  }
});

// Fetch all reports


// Update report status (set to 'Resolved')
app.put('/report/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;  // Ensure status is either 'Pending' or 'Resolved'

  if (!status || !['Pending', 'Resolved'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
  }

  try {
      const report = await Report.findById(id);
      if (!report) {
          return res.status(404).json({ error: 'Report not found' });
      }

      report.status = status;  // Update the status
      await report.save();
      res.json({ success: true, message: 'Report status updated successfully' });
  } catch (err) {
      res.status(500).json({ error: 'Failed to update report status' });
  }
});
// Add a new report
app.post('/addreport', async (req, res) => {
  if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
      const { title, description, location, category } = req.body;

      const report = new Report({
          title,
          description,
          location,
          category,
          status: 'Pending'
      });

      await report.save();
      res.json({ success: true, message: 'Report added successfully' });
  } catch (err) {
      res.status(500).json({ error: 'Failed to add report' });
  }
});
// Mark a report as resolved
app.put('/report/:id/resolve', async (req, res) => {
  const { id } = req.params;

  try {
    const report = await Report.findById(id);
    if (!report) return res.status(404).json({ message: 'Report not found' });

    report.status = 'Resolved'; // Update status to resolved
    await report.save();

    res.status(200).json({ message: 'Report resolved successfully' });
  } catch (err) {
    console.error('Error updating report status:', err);
    res.status(500).json({ message: 'Failed to resolve report' });
  }
});

// Delete a report
app.delete('/report/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await Report.findByIdAndDelete(id);
    if (!result) return res.status(404).json({ message: 'Report not found' });

    res.status(200).json({ message: 'Report deleted successfully' });
  } catch (err) {
    console.error('Error deleting report:', err);
    res.status(500).json({ message: 'Failed to delete report' });
  }
});

// Fetch all reports
app.get('/reports', async (req, res) => {
  try {
      const reports = await Report.find();
      res.json(reports);
  } catch (err) {
      res.status(500).json({ error: 'Failed to fetch reports' });
  }
});
// Delete report by ID
app.delete('/report/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await Report.findByIdAndDelete(id);
    if (!result) return res.status(404).json({ message: 'Report not found' });

    res.status(200).json({ message: 'Report deleted successfully' });
  } catch (err) {
    console.error('Error deleting report:', err);
    res.status(500).json({ message: 'Failed to delete report' });
  }
});




const { spawn } = require('child_process');

app.get('/run-python', (req, res) => {
    // Spawn a child process to run the Python script
    const python = spawn('python', ['Recommendation/main.py']);  // Replace with your script name
    
    python.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
    });
    
    python.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });
    
    python.on('close', (code) => {
        console.log(`Python script finished with code ${code}`);
        res.send('Python script finished running!');
    });
});



const { authorize } = require('./google-auth');


// API route to create and send a Google Meet link
app.post('/send-meet-link', (req, res) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    authorize((auth) => {
        createMeetLink(auth, (meetLink) => {
            console.log('Google Meet link created:', meetLink);

            sendSMS(phoneNumber, meetLink)
                .then(() => {
                    res.json({ success: true, meetLink });
                })
                .catch((error) => {
                    console.error('Error sending SMS:', error);
                    res.status(500).json({ success: false, error: 'Failed to send SMS' });
                });
        });
    });
});


// Endpoint to send SOS
app.post("/send-sos", (req, res) => {
  const { message, location } = req.body;

  // Sending SMS
  client.messages
    .create({
      body: `${message} Location: ${location}`,
      from: twilioPhoneNumber,
      to: req.session.useremergencycontact,
    })
    .then(() => {
      console.log("SOS message sent");
    })
    .catch((err) => {
      console.error("Error sending SOS:", err);
    });

    
  // Triggering an alert call
  client.calls
    .create({
      twiml: `<Response>
      <Say voice="alice" language="en-IN">${message}. The location has been sent to your message.</Say>
    </Response>`,
      to: req.session.useremergencycontact,
      from: twilioPhoneNumber,
    })
    .then((call) => {
      console.log(`Call initiated: ${call.sid}`);
    })
    .catch((error) => {
      console.error("Error making call:", error);
    });

  res.json({ status: "SOS Sent" });
});
app.post('/logout', (req, res) => {
  if (req.session.userId) {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).send("Error during logout");
      }
      res.clearCookie('connect.sid');
      res.status(200).send({ status: "Logout successful" });  // Send JSON response
    });
  } else {
    res.status(400).send({ status: "No user is logged in" });
  }
});


// Start HTTPS server
https.createServer(sslOptions, app).listen(port, () => {
  console.log(`Server running at https://192.168.0.102:${port}`);
    // Automatically open the URL in the default web browser
    const url = `https://192.168.0.102:${port}`;

    // Check the operating system and run the appropriate command
    if (process.platform === 'win32') {
      exec(`start ${url}`);  // Windows
    } else if (process.platform === 'darwin') {
      exec(`open ${url}`);   // macOS
    } else {
      exec(`xdg-open ${url}`);  // Linux
    }
});

  