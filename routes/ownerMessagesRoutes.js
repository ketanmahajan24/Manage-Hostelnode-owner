/* ============================================================
   ownerMessagesRoutes.js — HostelNode Owner-side PG/Hostel Messages
   NEW FILE — Phase 4 of the PG/Hostel chat feature.

   This is deliberately a small, separate file rather than more
   additions to the already-very-large routes/userRoutes.js. It is
   mounted at the same "/user" prefix as userRoutes.js in app.js, so
   from the browser's point of view it's just two more pages in the
   owner dashboard: /user/messages and /user/messages/:conversationId.

   Only two routes live here — an inbox list and a thread-page render.
   Actually SENDING a reply, polling for new messages, and marking
   messages read are NOT duplicated here: the owner-conversation.ejs
   page's JS calls the exact same shared endpoints Phase 2 already
   built —
     POST /messages/:conversationId/messages
     GET  /messages/:conversationId/poll
     POST /messages/:conversationId/read
   — which already accept an Owner viewer via routes/messagesRoutes.js's
   `resolveViewer` (checks the Owner's `token` cookie) and `isParticipant`
   (checks `conv.ownerParticipant` for a PG_INQUIRY conversation). So no
   further backend chat logic needed to be written or changed for the
   owner to actually chat — this file only adds the two pages an owner
   needs to reach and read that thread.

   Auth: reuses the exact same `jwtAuthMiddleware` every other owner
   route in routes/userRoutes.js already uses (owner's `token` cookie).
   No new auth mechanism introduced.
============================================================ */

const express = require("express");
const router = express.Router();

const { jwtAuthMiddleware } = require("../jwt.js");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

function listingTitle(listing) {
  if (!listing) return "PG / Hostel listing";
  return listing.title || "PG / Hostel listing";
}

function getUnread(conv, ownerId) {
  if (!conv.unreadCounts) return 0;
  if (typeof conv.unreadCounts.get === "function") return conv.unreadCounts.get(ownerId) || 0;
  return conv.unreadCounts[ownerId] || 0;
}

/* ─────────────────────────────────────────────
   INBOX  →  GET /user/messages
   Every PG_INQUIRY conversation where this Owner is the
   ownerParticipant, newest activity first. Flatmate has no owner
   side, so this list is PG/Hostel-only by construction.
───────────────────────────────────────────── */
router.get("/messages", jwtAuthMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.id;

    const conversations = await Conversation.find({
      type: "PG_INQUIRY",
      ownerParticipant: ownerId,
    })
      .populate("participants", "firstName")
      .populate("listing")
      .sort({ updatedAt: -1 })
      .lean();

    const rows = conversations.map((conv) => {
      const student = (conv.participants || [])[0] || null;
      return {
        conversationId: conv._id.toString(),
        studentName: student?.firstName || "HostelNode User",
        listingTitle: listingTitle(conv.listing),
        lastMessage: conv.lastMessage || "",
        unread: getUnread(conv, ownerId),
        updatedAt: conv.updatedAt,
      };
    });

    res.render("messages/owner-inbox", { rows });
  } catch (err) {
    console.error("Owner inbox error:", err);
    res.status(500).send("Something went wrong loading your messages. Please try again.");
  }
});

/* ─────────────────────────────────────────────
   CHAT THREAD  →  GET /user/messages/:conversationId
   Renders the thread page. Reply/poll/read-ack all go through the
   existing shared /messages/:id/... endpoints from Phase 2 — this
   route only has to fetch and hand over the initial page of messages.
───────────────────────────────────────────── */
router.get("/messages/:conversationId", jwtAuthMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.id;

    const conv = await Conversation.findById(req.params.conversationId)
      .populate("participants", "firstName")
      .populate("listing")
      .lean();

    // Must be a PG_INQUIRY conversation, and this owner must actually be
    // its ownerParticipant — never trust the conversationId in the URL
    // alone. A Flatmate conversation, or another owner's conversation,
    // renders the same "not found" state as a missing id.
    if (!conv || conv.type !== "PG_INQUIRY" || !conv.ownerParticipant || conv.ownerParticipant.toString() !== ownerId) {
      return res.status(404).render("messages/owner-conversation", {
        conversation: null, messages: [], counterpart: null, viewerId: null, listingText: "",
      });
    }

    const student = (conv.participants || [])[0] || null;
    const counterpart = student ? { _id: student._id, firstName: student.firstName } : null;

    const messages = await Message.find({ conversation: conv._id }).sort({ createdAt: 1 }).lean();

    // Same "opening the chat = delivered + read" stamping as the
    // student-side thread route in routes/messagesRoutes.js.
    const now = new Date();
    await Conversation.updateOne({ _id: conv._id }, { $set: { [`unreadCounts.${ownerId}`]: 0 } });
    await Message.updateMany(
      { conversation: conv._id, sender: { $ne: ownerId }, readAt: null },
      { $set: { readAt: now } }
    );
    await Message.updateMany(
      { conversation: conv._id, sender: { $ne: ownerId }, deliveredAt: null },
      { $set: { deliveredAt: now } }
    );

    res.render("messages/owner-conversation", {
      conversation: conv,
      messages,
      counterpart,
      viewerId: ownerId,
      listingText: listingTitle(conv.listing),
    });
  } catch (err) {
    console.error("Owner conversation view error:", err);
    res.status(500).send("Something went wrong loading this conversation. Please try again.");
  }
});

module.exports = router;
