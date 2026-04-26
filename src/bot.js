require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const { spawn } = require("child_process");

const DISCORD_TOKEN = process.env.REQUEST_BOT_TOKEN;
const CLIENT_ID = process.env.REQUEST_BOT_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

for (const [name, value] of Object.entries({
  REQUEST_BOT_TOKEN: DISCORD_TOKEN,
  REQUEST_BOT_CLIENT_ID: CLIENT_ID,
  DISCORD_GUILD_ID: GUILD_ID,
})) {
  if (!value) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
}

const queue = [];
let current = null;
let isPlaying = false;

const commands = [
  new SlashCommandBuilder()
    .setName("request")
    .setDescription("Request a link to play through Kenku FM")
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("YouTube, SoundCloud, direct audio URL, etc.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current request queue"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current request"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playback and clear the queue"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the current request"),
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

function finishCurrent() {
  current = null;
  isPlaying = false;

  setTimeout(() => {
    playNext();
  }, 500);
}

function stopCurrent() {
  if (!current) return;

  try {
    current.ytdlp?.kill("SIGKILL");
  } catch {}

  try {
    current.ffplay?.kill("SIGKILL");
  } catch {}

  current = null;
  isPlaying = false;
}

function playNext() {
  if (isPlaying) return;
  if (queue.length === 0) return;

  const item = queue.shift();
  isPlaying = true;

  console.log(`Now playing: ${item.url}`);

  const ytdlp = spawn("yt-dlp", [
    "--no-playlist",
    "-f",
    "bestaudio/best",
    "-o",
    "-",
    item.url,
  ], {
    windowsHide: true,
  });

  const ffplay = spawn("ffplay", [
    "-nodisp",
    "-autoexit",
    "-loglevel",
    "error",
    "-",
  ], {
    windowsHide: true,
  });

  current = {
    ytdlp,
    ffplay,
    item,
    startedAt: new Date(),
  };

  ytdlp.stdout.pipe(ffplay.stdin);

  ytdlp.stderr.on("data", data => {
    console.log(`[yt-dlp] ${data.toString()}`);
  });

  ffplay.stderr.on("data", data => {
    console.log(`[ffplay] ${data.toString()}`);
  });

  ytdlp.on("error", error => {
    console.error("Failed to start yt-dlp:", error);
    stopCurrent();
    playNext();
  });

  ffplay.on("error", error => {
    console.error("Failed to start ffplay:", error);
    stopCurrent();
    playNext();
  });

  ffplay.on("exit", code => {
    console.log(`ffplay exited with code ${code}`);
    finishCurrent();
  });

  ytdlp.on("exit", code => {
    if (code !== 0 && current?.item === item) {
      console.log(`yt-dlp exited with code ${code}`);
    }
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", () => {
  console.log(`Request bot logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "request") {
      const url = interaction.options.getString("url", true).trim();

      queue.push({
        url,
        userId: interaction.user.id,
        username: interaction.user.username,
      });

      const position = isPlaying ? queue.length : 1;

      await interaction.reply(
        `Added to queue:\n${url}\nPosition: ${position}`
      );

      playNext();
      return;
    }

    if (interaction.commandName === "queue") {
      const nowPlaying = current
        ? `Now playing:\n${current.item.url}\nRequested by: ${current.item.username}\n\n`
        : "Nothing is currently playing.\n\n";

      if (queue.length === 0) {
        await interaction.reply(nowPlaying + "Queue is empty.");
        return;
      }

      const list = queue
        .slice(0, 10)
        .map((item, index) => `${index + 1}. ${item.url} — requested by ${item.username}`)
        .join("\n");

      const extra = queue.length > 10
        ? `\n...and ${queue.length - 10} more.`
        : "";

      await interaction.reply(nowPlaying + list + extra);
      return;
    }

    if (interaction.commandName === "skip") {
      if (!current) {
        await interaction.reply("Nothing is currently playing.");
        return;
      }

      const skipped = current.item.url;
      stopCurrent();

      await interaction.reply(`Skipped:\n${skipped}`);

      playNext();
      return;
    }

    if (interaction.commandName === "stop") {
      queue.length = 0;
      stopCurrent();

      await interaction.reply("Stopped playback and cleared the queue.");
      return;
    }

    if (interaction.commandName === "nowplaying") {
      if (!current) {
        await interaction.reply("Nothing is currently playing.");
        return;
      }

      await interaction.reply(
        `Now playing:\n${current.item.url}\nRequested by: ${current.item.username}`
      );
      return;
    }
  } catch (error) {
    console.error(error);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "Something went wrong while handling that command.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "Something went wrong while handling that command.",
        ephemeral: true,
      });
    }
  }
});

registerCommands()
  .then(() => client.login(DISCORD_TOKEN))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });