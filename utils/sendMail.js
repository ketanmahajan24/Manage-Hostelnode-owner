const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "hostelnodehelp@gmail.com",
    pass: "sxiwxzxbdujxiyra"
  }
});

const sendMail = async (to, subject, html) => {
  try {
    await transporter.sendMail({
      from: '"HostelNode"<hostelnodehelp@gmail.com>',
      to,
      subject,
      html
    });

    console.log("✅ Email sent");
    return true;

  } catch (err) {
    console.error("❌ Email error:", err);
    return false;
  }
};

module.exports = { sendMail };