# Gewenchi Clinic Booking API

A clinic appointment booking API (Node.js + PostgreSQL) with a simple booking web page. This guide walks you through setting up the project, deploying it on Render with a Neon database, and testing it.

---

## Step 1: Project file structure

Your project should look like this:

```
gewenchi-clinic-api/
  server.js
  package.json
  test.js
  README.md
  public/
    index.html
```

Add a `.gitignore` file in the same folder containing one line:

```
node_modules
```

---

## Step 2: Create the database on Neon

1. Sign up at [neon.tech](https://neon.tech) and click **Create project**. Any name works. Pick the region closest to where you'll host on Render.
2. On the project dashboard, click **Connect**.
3. Copy the connection string. It looks like:

   ```
   postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require
   ```

4. Keep it somewhere safe. You'll paste it into Render shortly.

> You don't need to create any tables. The server creates them when it starts.

---

## Step 3: Push the code to GitHub

1. Create a new empty repository on [github.com](https://github.com), for example `gewenchi-clinic-booking-api`.
2. In a terminal, inside the `gewenchi-clinic-api` folder, run:

   ```bash
   git init
   git add .
   git commit -m "Clinic booking API"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/gewenchi-clinic-booking-api.git
   git push -u origin main
   ```

3. Refresh the repo page and confirm you can see `server.js` and the `public` folder.

---

## Step 4: Deploy on Render

1. Sign up at [render.com](https://render.com). Signing in with GitHub makes the next step easier.
2. Click **New +**, then **Web Service**, then connect your repository.
3. Fill in the form:

   | Setting | Value |
   |---|---|
   | Language | Node |
   | Branch | `main` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | Free |

4. Open **Environment Variables** and add two:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Your Neon connection string |
   | `API_KEY` | A secret you choose. Make it long and random, because the assessors will use it as `X-API-Key`. |

5. Click **Create Web Service**. The first build takes 2 to 4 minutes.

---

## Step 5: Check that it's live

When the Render log shows `listening` and the status turns green, you'll have a URL like `https://gewenchi-clinic-booking-api.onrender.com`.

- Open `https://your-url/health`. You should see `{"ok":true}`.
- Open `https://your-url/` to see the booking page.
- Visit `https://your-url/slots` in the browser. You should get a **401 JSON error**, which means the API key check works.

---

## Step 6: Run the test script

Run it on your computer, in the folder that contains `test.js`.

**macOS / Linux:**

```bash
BASE_URL=https://your-url.onrender.com API_KEY=yoursecret node test.js
```

**Windows PowerShell** (set the variables first):

```powershell
$env:BASE_URL="https://your-url.onrender.com"; $env:API_KEY="yoursecret"; node test.js
```

Fix anything that shows `FAIL` before you submit.

### Running the tests on Windows, step by step

**1. Check that Node is installed (version 18 or newer)**

```powershell
node --version
```

If you get an error or a version below 18, install the LTS version from [nodejs.org](https://nodejs.org), then close and reopen PowerShell.

**2. Go to the folder that contains `test.js`**

```powershell
cd C:\path\to\gewenchi-clinic-api
```

Replace the path with wherever you saved the project. You can also open the folder in File Explorer, click the address bar, type `powershell` and press Enter.

**3. Set your URL and key (replace the key with your real one)**

```powershell
$env:BASE_URL="https://gewenchi-clinic-api.onrender.com"
$env:API_KEY="your-real-api-key"
```

**4. Run the tests**

```powershell
node test.js
```

The script doesn't need `npm install`, because it only uses Node's built-in `fetch`.

### What to expect

- Each check prints `PASS` or `FAIL`, and the run ends with something like `38 passed, 0 failed`.
- The first request may take up to 30 seconds if Render has gone to sleep. That's normal.
- The test wipes and refills the slots, so after it finishes you can reload your page, click **Load slots**, and you'll see slots to book.
- The variables only last for that PowerShell window. If you open a new one, set them again.

---

## Step 7: Try the web page

The page showing **"No slots."** is expected at first, because the database is empty until `/reset` adds slots, and the test script does that.

The test script leaves 12 slots in the database. To try booking:

1. Open your URL.
2. Paste your API key.
3. Click **Load slots**.
4. Select a slot and book it.

You should see the confirmation card.
