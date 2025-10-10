import bcrypt from 'bcryptjs';
import db from "./db.js";

const username = "admin";
const newPass = "Mahi_reddy1";

const run = async () => {
  const hash = await bcrypt.hash(newPass, 10);
  console.log("New hash:", hash);

  db.run(
    "UPDATE users SET password_hash = ? WHERE username = ?",
    [hash, username],
    (err) => {
      if (err) console.error("Error updating admin password:", err);
      else console.log(`✅ Admin password reset to: ${newPass}`);
      process.exit(0);
    }
  );
};

run();
