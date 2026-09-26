/* ============================================================
   messagesRoutes.js — SLIM, PG/Hostel-chat-only variant
   FOR Manage-Hostelnode-owner ONLY — not the main HostelNode.com repo.

   Your main repo's routes/messagesRoutes.js is one shared file
   serving BOTH Flatmate (Student<->Student) chat AND PG/Hostel
   (Student<->Owner) chat, because students hit both from
   hostelnode.com. This deployment never serves students at all —
   only the Owner dashboard runs here — so this file keeps just the
   3 endpoints your owner-conversation.ejs page's JS actually calls:

     POST /messages/:conversationId/messages   (send a reply)
     POST /messages/:conversationId/read        (mark read)
     GET  /messages/:conversationId/poll        (check for new messages)

   Every line below is copied verbatim from the main repo's route
   bodies — nothing reconstructed from memory — with only the
   genuinely Flatmate-only branches removed (the FLATMATE_CONNECTION
   checks, the Block check, and the "Student messages Owner" notify
   branch, which can't happen on this deployment since students never
   reach it). If you ever diff this against the main repo's file,
   every remaining line should match exactly.

   Dropped, on purpose, because nothing in this deployment ever hits
   them (they're for the Student side, which lives on hostelnode.com):
     GET  /messages                     (Student inbox)
     POST /messages/pg/start            (Student starts a PG chat)
     GET  /messages/:conversationId     (Student's chat-thread page —
                                          the Owner has its own render,
                                          in routes/ownerMessagesRoutes.js)
     /messages/connection/:id/accept|decline|remove   (Flatmate only)
     /messages/block/:studentId, /messages/report      (Flatmate only)

   That's also why this file needs only Conversation, Message, Student,
   and utils/flatmateNotifications.js (to notify the Student when the
   Owner replies) — none of Block, Report, FlatmateConnection, or
   FlatmateListing, which the dropped routes were the only things that
   ever used.
============================================================ */

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Student = require("../models/studentSchema");
const { notifyFlatmateEvent } = require("../utils/flatmateNotifications");

/* ── resolveViewer — identical to the main repo's version. ── */
function resolveViewer(req, res, next) {
  const studentToken = req.cookies?.studentToken;
  if (studentToken) {
    try {
      const decoded = jwt.verify(studentToken, process.env.JWT_SECRET);
      req.viewer = { id: decoded.id, kind: "Student" };
      return next();
    } catch (err) {
      res.clearCookie("studentToken");
    }
  }

  const ownerToken = req.cookies?.token;
  if (ownerToken) {
    try {
      const decoded = jwt.verify(ownerToken, process.env.JWT_SECRET);
      req.viewer = { id: decoded.id, kind: "Owner" };
      return next();
    } catch (err) {
      res.clearCookie("token");
    }
  }

  req.viewer = null;
  next();
}

/* ── isParticipant — identical to the main repo's version. ── */
function isParticipant(conv, viewer) {
  if (!conv || !viewer) return false;
  if (viewer.kind === "Owner") {
    return !!conv.ownerParticipant && conv.ownerParticipant.toString() === viewer.id;
  }
  return (conv.participants || []).some((p) => (p._id || p).toString() === viewer.id);
}

/* ─────────────────────────────────────────────
   SEND MESSAGE  →  POST /messages/:conversationId/messages
───────────────────────────────────────────── */
router.post("/:conversationId/messages", resolveViewer, async (req, res) => {
  try {
    const viewer = req.viewer;
    const conv = await Conversation.findById(req.params.conversationId);

    if (!conv || !isParticipant(conv, viewer)) {
      return res.status(403).json({ success: false, error: "Not authorized." });
    }
    if (conv.status !== "active") {
      return res.json({ success: false, error: "This conversation has ended." });
    }

    // Only PG_INQUIRY conversations ever exist on this deployment, so
    // the receiver is always the other side of that pair.
    const receiverId = viewer.kind === "Owner" ? conv.participants[0] : conv.ownerParticipant;
    const receiverKind = viewer.kind === "Owner" ? "Student" : "Owner";

    const text = (req.body.text || "").trim().slice(0, 2000);
    if (!text) return res.json({ success: false, error: "Message can't be empty." });

    const message = await Message.create({
      conversation: conv._id, sender: viewer.id, senderModel: viewer.kind, text,
    });

    conv.lastMessage = text.slice(0, 140);
    conv.lastMessageAt = new Date();
    const currentUnread = (conv.unreadCounts.get ? conv.unreadCounts.get(receiverId.toString()) : 0) || 0;
    conv.unreadCounts.set(receiverId.toString(), currentUnread + 1);
    await conv.save();

    // Owner replies → notify the Student (identical to the main repo's
    // "Student receiver" branch). The reverse direction — Student
    // messages Owner — happens on hostelnode.com's own copy of this
    // route, never here, so that branch isn't included in this file.
    if (receiverKind === "Student") {
      (async () => {
        const [senderDoc, receiverDoc] = await Promise.all([
          Student.findById(viewer.id).select("firstName").lean().catch(() => null),
          Student.findById(receiverId).select("phone").lean().catch(() => null),
        ]);
        notifyFlatmateEvent("NEW_MESSAGE", {
          userId: receiverId,
          title: "New message",
          body: text.slice(0, 80),
          link: `/messages/${conv._id}`,
          relatedConversation: conv._id,
          dedupeKey: message._id.toString(),
          // No message text in the WhatsApp variables on purpose — see
          // the registry comment above NEW_MESSAGE in the main repo's
          // utils/flatmateNotifications.js.
          whatsapp: receiverDoc?.phone ? { phone: receiverDoc.phone, variables: [senderDoc?.firstName || "Someone"] } : null,
        });
      })();
    }

    res.json({
      success: true,
      message: {
        _id: message._id.toString(), text: message.text, createdAt: message.createdAt, mine: true,
        deliveredAt: null, readAt: null,
      },
    });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ success: false, error: "Something went wrong sending your message." });
  }
});

/* ─────────────────────────────────────────────
   MARK READ  →  POST /messages/:conversationId/read
───────────────────────────────────────────── */
router.post("/:conversationId/read", resolveViewer, async (req, res) => {
  try {
    const viewerId = req.viewer?.id;
    const conv = await Conversation.findById(req.params.conversationId);
    if (!conv || !isParticipant(conv, req.viewer)) {
      return res.status(403).json({ success: false, error: "Not authorized." });
    }

    const now = new Date();
    await Conversation.updateOne({ _id: conv._id }, { $set: { [`unreadCounts.${viewerId}`]: 0 } });
    await Message.updateMany(
      { conversation: conv._id, sender: { $ne: viewerId }, readAt: null },
      { $set: { readAt: now } }
    );
    // Read implies delivered — cover the (rare) case a message was read
    // via this route before a poll cycle had a chance to mark it delivered.
    await Message.updateMany(
      { conversation: conv._id, sender: { $ne: viewerId }, deliveredAt: null },
      { $set: { deliveredAt: now } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not mark as read." });
  }
});

/* ─────────────────────────────────────────────
   POLL FOR NEW MESSAGES  →  GET /messages/:conversationId/poll?after=<ISO date>
   Lightweight alternative to websockets (no socket.io in this project) —
   the chat page calls this every few seconds for near-real-time updates.
   Also doubles as the "delivered" signal: the viewer's client reaching
   this endpoint at all proves their device is live and has received
   whatever the other participant sent, independent of whether the tab
   is actually focused (that distinction is "read", handled above).
───────────────────────────────────────────── */
router.get("/:conversationId/poll", resolveViewer, async (req, res) => {
  try {
    const viewerId = req.viewer?.id;
    const conv = await Conversation.findById(req.params.conversationId);
    if (!conv || !isParticipant(conv, req.viewer)) {
      return res.status(403).json({ success: false, error: "Not authorized." });
    }

    await Message.updateMany(
      { conversation: conv._id, sender: { $ne: viewerId }, deliveredAt: null },
      { $set: { deliveredAt: new Date() } }
    );

    const after = req.query.after ? new Date(req.query.after) : new Date(0);
    const newMessages = await Message.find({ conversation: conv._id, createdAt: { $gt: after } })
      .sort({ createdAt: 1 })
      .lean();

    // Status (delivered/read) for the viewer's OWN messages the other
    // side hasn't read yet, so ticks on already-rendered bubbles can be
    // upgraded live without a full page reload. Bounded to "not yet
    // read" ones since once a message is read its ticks never change
    // again, so there's nothing left to push.
    const pendingMine = await Message.find({ conversation: conv._id, sender: viewerId, readAt: null })
      .select("_id deliveredAt readAt")
      .lean();

    res.json({
      success: true,
      status: conv.status,
      messages: newMessages.map((m) => ({
        _id: m._id.toString(), text: m.text, createdAt: m.createdAt,
        mine: m.sender.toString() === viewerId,
        deliveredAt: m.deliveredAt, readAt: m.readAt,
      })),
      statusUpdates: pendingMine.map((m) => ({
        _id: m._id.toString(), deliveredAt: m.deliveredAt, readAt: m.readAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Poll failed." });
  }
});

module.exports = router;
