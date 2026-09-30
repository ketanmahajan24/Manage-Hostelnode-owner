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
// Redesign Phase 3 — Messages now render inside the main layout (sidebar +
// top bar), which needs the owner and their properties.
const attachHostel = require("../Middlewares/attachHostel");
const Owner = require("../models/owner");
// HN_NEW_UI=0 keeps the previous standalone pages (unchanged files).
const view = name => (process.env.HN_NEW_UI === "0" ? `messages/${name}` : `messages/${name}-v2`);

function listingTitle(listing) {
  if (!listing) return "PG / Hostel listing";
  return listing.title || "PG / Hostel listing";
}

function getUnread(conv, ownerId) {
  if (!conv.unreadCounts) return 0;
  if (typeof conv.unreadCounts.get === "function") return conv.unreadCounts.get(ownerId) || 0;
  return conv.unreadCounts[ownerId] || 0;
}

/* ── Suggested opening replies — NEW. The main hostelnode.com repo's
   routes/messagesRoutes.js has an equivalent PG_TENANT_SUGGESTIONS
   list for the Student side; this is that file's Owner-side
   counterpart, duplicated here rather than shared across repos since
   this is a separate deployment with its own codebase. Only one set
   needed here (unlike that file, which also needs a tenant set) —
   every viewer on this route is always the Owner. ── */
const PG_OWNER_SUGGESTIONS = [
  "Hi! Thanks for reaching out — yes, we do have rooms available.",
  "When are you looking to move in?",
  "Let me know your budget and preferred sharing type (single/double/triple).",
  "I can share more photos or arrange a visit — what works for you?",
  "Are you a student or a working professional?",
  "Do you have any specific requirements I should know about?",
  "I'll need a valid ID and one month's advance to confirm the booking.",
  "Feel free to ask me anything about the PG or the area!",
  "Would a video call work before an in-person visit?",
  "Let me know if you'd like more details about the amenities.",
];

/* ─────────────────────────────────────────────
   INBOX  →  GET /user/messages
   Every PG_INQUIRY conversation where this Owner is the
   ownerParticipant, newest activity first. Flatmate has no owner
   side, so this list is PG/Hostel-only by construction.
───────────────────────────────────────────── */
router.get("/messages", jwtAuthMiddleware, attachHostel, async (req, res) => {
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

    const user = await Owner.findById(ownerId).lean();
    res.render(view("owner-inbox"), { rows, user });
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
router.get("/messages/:conversationId", jwtAuthMiddleware, attachHostel, async (req, res) => {
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
    const user = await Owner.findById(ownerId).lean();

    if (!conv || conv.type !== "PG_INQUIRY" || !conv.ownerParticipant || conv.ownerParticipant.toString() !== ownerId) {
      return res.status(404).render(view("owner-conversation"), {
        conversation: null, messages: [], counterpart: null, viewerId: null, listingText: "", suggestions: [], user,
      });
    }

    const student = (conv.participants || [])[0] || null;
    const counterpart = student ? { _id: student._id, firstName: student.firstName } : null;

    const messages = await Message.find({ conversation: conv._id }).sort({ createdAt: 1 }).lean();

    // Same "opening the chat = delivered + read" stamping as the
    // student-side thread route in routes/messagesRoutes.js.
    const now = new Date();
    // Redesign Phase 3 — this chat is being read now, so take it off the
    // sidebar's Messages badge on this page too.
    if (res.locals.hn2 && res.locals.hn2.unreadMessages) {
      res.locals.hn2 = { ...res.locals.hn2, unreadMessages: Math.max(0, res.locals.hn2.unreadMessages - getUnread(conv, ownerId)) };
    }
    await Conversation.updateOne({ _id: conv._id }, { $set: { [`unreadCounts.${ownerId}`]: 0 } });
    await Message.updateMany(
      { conversation: conv._id, sender: { $ne: ownerId }, readAt: null },
      { $set: { readAt: now } }
    );
    await Message.updateMany(
      { conversation: conv._id, sender: { $ne: ownerId }, deliveredAt: null },
      { $set: { deliveredAt: now } }
    );

    // NEW — same "empty/near-empty active chat" gate as the Student
    // side's PG_TENANT_SUGGESTIONS in the main repo.
    const suggestions = (conv.status === "active" && messages.length <= 2)
      ? PG_OWNER_SUGGESTIONS
      : [];

    res.render(view("owner-conversation"), {
      conversation: conv,
      messages,
      counterpart,
      viewerId: ownerId,
      listingText: listingTitle(conv.listing),
      suggestions,
      user,
    });
  } catch (err) {
    console.error("Owner conversation view error:", err);
    res.status(500).send("Something went wrong loading this conversation. Please try again.");
  }
});

module.exports = router;
