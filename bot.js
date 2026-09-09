require("dotenv").config();
const { Telegraf, Scenes, session } = require("telegraf");
const {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const bs58 = require("bs58");

const NETWORK = "mainnet-beta";

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const connection = new Connection(clusterApiUrl(NETWORK), "confirmed");

// In-memory storage: userId -> Keypair
const userWallets = {};

// ---- Send wizard: amount -> address -> times -> confirm ----
const sendWizard = new Scenes.WizardScene(
  "send-wizard",
  async (ctx) => {
    if (!userWallets[ctx.from.id]) {
      await ctx.reply("No key set. Use /setkey <your_private_key> first.");
      return ctx.scene.leave();
    }
    await ctx.reply("How much SOL do you want to send?");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const amount = parseFloat(ctx.message.text);
    if (isNaN(amount) || amount < 0) {
      await ctx.reply("That's not a valid amount. Try again:");
      return;
    }
    ctx.wizard.state.amount = amount;
    await ctx.reply("What's the recipient's wallet address?");
    return ctx.wizard.next();
  },
  async (ctx) => {
    let recipient;
    try {
      recipient = new PublicKey(ctx.message.text.trim());
    } catch (err) {
      await ctx.reply("That doesn't look like a valid Solana address. Try again:");
      return;
    }
    ctx.wizard.state.recipient = recipient;
    ctx.wizard.state.recipientText = ctx.message.text.trim();
    await ctx.reply("How many times should this be sent? (1-20)");
    return ctx.wizard.next();
  },
  async (ctx) => {
    const times = parseInt(ctx.message.text.trim());
    if (isNaN(times) || times < 1 || times > 20) {
      await ctx.reply("Enter a number between 1 and 20:");
      return;
    }
    ctx.wizard.state.times = times;

    const { amount, recipientText } = ctx.wizard.state;
    await ctx.reply(
      "Confirm: send " + amount + " SOL to " + recipientText + ", " + times + " time(s)?\nReply yes or no."
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const answer = ctx.message.text.trim().toLowerCase();
    if (answer !== "yes") {
      await ctx.reply("Cancelled.");
      return ctx.scene.leave();
    }

    const keypair = userWallets[ctx.from.id];
    const { amount, recipient, times } = ctx.wizard.state;

    for (let i = 1; i <= times; i++) {
      try {
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: recipient,
            lamports: Math.round(amount * LAMPORTS_PER_SOL),
          })
        );

        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);

        await ctx.reply(
          "(" + i + "/" + times + ") Sent! Signature: " + signature +
          "\nView: https://explorer.solana.com/tx/" + signature + "?cluster=" + NETWORK
        );
      } catch (err) {
        await ctx.reply("(" + i + "/" + times + ") Error: " + err.message);
      }
    }

    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([sendWizard]);
bot.use(session());
bot.use(stage.middleware());

bot.start((ctx) => {
  ctx.reply(
    "Hi! Before sending, set your wallet with:\n/setkey <your_private_key>\n\n" +
    "Then use:\n/send"
  );
});

bot.command("setkey", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const rawKey = parts[1];

  if (!rawKey) {
    return ctx.reply("Usage: /setkey <your_private_key>");
  }

  try {
    const secretKey = bs58.decode(rawKey);
    const keypair = Keypair.fromSecretKey(secretKey);
    userWallets[ctx.from.id] = keypair;

    try {
      await ctx.deleteMessage(ctx.message.message_id);
    } catch (err) {
      // Bot might not have delete permission in some chat types; not critical
    }

    ctx.reply("Key saved. Your wallet: " + keypair.publicKey.toBase58());
  } catch (err) {
    ctx.reply("That doesn't look like a valid private key.");
  }
});

bot.command("forgetkey", (ctx) => {
  delete userWallets[ctx.from.id];
  ctx.reply("Your key has been removed from memory.");
});

bot.command("wallet", async (ctx) => {
  const keypair = userWallets[ctx.from.id];
  if (!keypair) {
    return ctx.reply("No key set. Use /setkey <your_private_key> first.");
  }

  try {
    const balanceLamports = await connection.getBalance(keypair.publicKey);
    const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;
    ctx.reply("Your wallet: " + keypair.publicKey.toBase58() + "\nBalance: " + balanceSOL + " SOL");
  } catch (err) {
    ctx.reply("Your wallet: " + keypair.publicKey.toBase58() + "\n(Couldn't fetch balance: " + err.message + ")");
  }
});

bot.command("send", (ctx) => ctx.scene.enter("send-wizard"));

bot.launch();
console.log("Bot is running...");