import "dotenv/config";
import { InteractionType, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const password = process.env.RELAY_SEED_PASSWORD;

const seedId = (value: number): string => `crelayseed${String(value).padStart(15, "0")}`;

const initialUsers = [
  {
    handle: "amine_dev",
    email: "amine@relay-seed.test",
    displayName: "Amine Bensaid",
    bio: "Mostly fixing the thing I broke five minutes ago.",
    avatarUrl: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=256&h=256&q=80",
  },
  {
    handle: "sarah_ui",
    email: "sarah@relay-seed.test",
    displayName: "Sarah Haddad",
    bio: "UI engineer. I will notice the 1px gap.",
    avatarUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&h=256&q=80",
  },
  {
    handle: "khalil_sec",
    email: "khalil@relay-seed.test",
    displayName: "Khalil Mansour",
    bio: "Security, coffee, and asking what happens if you try it twice.",
    avatarUrl: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=256&h=256&q=80",
  },
  {
    handle: "maya_builds",
    email: "maya@relay-seed.test",
    displayName: "Maya Chen",
    bio: "Shipping small things and taking too many screenshots.",
    avatarUrl: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=256&h=256&q=80",
  },
  {
    handle: "yasmin_codes",
    email: "yasmin@relay-seed.test",
    displayName: "Yasmin El Amrani",
    bio: "Frontend by day, little side projects after dinner.",
    avatarUrl: "https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=256&h=256&q=80",
  },
  {
    handle: "omar_said",
    email: "omar@relay-seed.test",
    displayName: "Omar Said",
    bio: "Backend stuff. Currently learning to stop overthinking it.",
    avatarUrl: "https://images.unsplash.com/photo-1504257432389-52343af06ae3?auto=format&fit=crop&w=256&h=256&q=80",
  },
  {
    handle: "lina_dev",
    email: "lina@relay-seed.test",
    displayName: "Lina Khoury",
    bio: "Design systems, playlists, and the occasional deploy.",
    avatarUrl: "https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=256&h=256&q=80",
  },
  {
    handle: "rami_pixel",
    email: "rami@relay-seed.test",
    displayName: "Rami Nasser",
    bio: "I make websites and lose at co-op games.",
    avatarUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=256&h=256&q=80",
  },
] as const;

const additionalProfiles = [
  ["noor_dev", "Noor Rahman", "Building web things between classes and coffee."],
  ["adam_codes", "Adam Faris", "Mostly JavaScript, occasionally a long walk."],
  ["farah_designs", "Farah Naji", "Making interfaces feel a little less fussy."],
  ["zayd_backend", "Zayd Karim", "APIs, old films, and too many terminal tabs."],
  ["hana_builds", "Hana Youssef", "Learning by shipping tiny projects."],
  ["eli_types", "Eli Morgan", "TypeScript fan. Yes, I have opinions about enums."],
  ["dina_digital", "Dina Saleh", "UX notes from whatever app I used today."],
  ["samir_linux", "Samir Haddad", "Linux tinkering and weekend side quests."],
  ["nour_codes", "Nour Khalil", "Frontend dev, still learning the backend bits."],
  ["jules_dev", "Jules Martin", "It compiled, so I went to make lunch."],
  ["layla_ux", "Layla Farouk", "Design systems and tiny details."],
  ["tariq_js", "Tariq Aziz", "Trying to keep my side projects small. Failing."],
  ["reem_builds", "Reem Saleh", "A little CSS, a little Arabic coffee."],
  ["youssef_cli", "Youssef Amin", "CLI tools, old keyboards, and quiet mornings."],
  ["nina_frontend", "Nina Park", "Frontend notes, mostly written after the bug is fixed."],
  ["fadi_api", "Fadi Mansour", "I like APIs that do exactly what they say."],
  ["salma_dev", "Salma Idris", "Working on a portfolio that keeps getting redesigned."],
  ["mike_pixel", "Mike Turner", "Pixels, prototypes, and a very patient cat."],
  ["hiba_codes", "Hiba Darwish", "Web dev in Beirut. Usually online after dinner."],
  ["ray_data", "Ray Chen", "Queries and dashboards; coffee is not optional."],
  ["malik_web", "Malik Omar", "Shipping a little, reading docs a lot."],
  ["tala_ui", "Tala Nasser", "Making the mobile version work before I call it done."],
  ["andy_stack", "Andy Brooks", "Full stack on paper, googling on schedule."],
  ["sami_dev", "Sami Khoury", "Trying to write fewer clever one-liners."],
  ["aya_codes", "Aya Ibrahim", "Code, sketchbook, repeat."],
  ["leo_debugs", "Leo Fischer", "Debugging is just reading carefully with extra steps."],
  ["mariam_web", "Mariam Saad", "Small web projects and big playlists."],
  ["karim_ops", "Karim Zaki", "Deploys, logs, and the occasional panic."],
  ["zoe_makes", "Zoe Patel", "Making useful things for people I know."],
  ["bilal_dev", "Bilal Hamdan", "Currently untangling a side project from 2022."],
  ["ruby_ui", "Ruby Ellis", "UI engineer; I keep a folder of good buttons."],
  ["nadia_codes", "Nadia Faris", "Learning backend one endpoint at a time."],
  ["hassan_cpp", "Hassan Jaber", "C++ when I have to, Rust when I can."],
  ["ivy_studies", "Ivy Brooks", "CS student, part-time bug collector."],
  ["maha_design", "Maha Ali", "Designing for the awkward edge cases too."],
  ["theo_web", "Theo Grant", "Web dev and an unreasonable number of bookmarks."],
  ["rana_dev", "Rana Kassem", "Trying to make my README less embarrassing."],
  ["devon_builds", "Devon Price", "Small tools for mildly annoying problems."],
  ["sana_js", "Sana Qureshi", "JavaScript, tea, and fixing yesterday's shortcuts."],
  ["mustafa_net", "Mustafa Saleh", "Networking rabbit holes and home lab updates."],
  ["ella_codes", "Ella James", "I make apps and forget to take breaks."],
  ["walid_dev", "Walid Tarek", "Aiming for boring deploys and readable code."],
] as const;

const avatarPhotos = [
  "photo-1535713875002-d1d0cf377fde",
  "photo-1527980965255-d3b416303d12",
  "photo-1508214751196-bcfd4ca60f91",
  "photo-1544005313-94ddf0286df2",
  "photo-1521119989659-a83eee488004",
  "photo-1504593811423-6dd665756598",
  "photo-1552058544-f2b08422138a",
  "photo-1547425260-76bcadfb4f2c",
  "photo-1599566150163-29194dcaad36",
  "photo-1517841905240-472988babdf9",
  "photo-1524504388940-b1c1722653e1",
  "photo-1494790108377-be9c29b29330",
  "photo-1531123897727-8f129e1688ce",
  "photo-1500648767791-00dcc994a43e",
];

const additionalUsers = additionalProfiles.map(([handle, displayName, bio], index) => ({
  handle,
  email: `${handle}@relay-seed.test`,
  displayName,
  bio,
  avatarUrl: `https://images.unsplash.com/${avatarPhotos[index % avatarPhotos.length]}?auto=format&fit=crop&w=256&h=256&q=80`,
}));

const users = [...initialUsers, ...additionalUsers];

type SeedPost = {
  id: number;
  author: string;
  body: string;
  minutesAgo: number;
  replyTo?: number;
};

const posts: SeedPost[] = [
  { id: 1, author: "sarah_ui", body: "CSS flexbox really said ‘looks fine on my machine’ and then moved the button 40px on Safari 🙃", minutesAgo: 34 },
  { id: 2, author: "amine_dev", body: "one missing semicolon turned into 45 mins of staring at the wrong file. classic", minutesAgo: 57 },
  { id: 3, author: "khalil_sec", body: "Me: quick security check before bed. Also me at 1:40am: why does this endpoint trust that header", minutesAgo: 83 },
  { id: 4, author: "maya_builds", body: "C is fun until you print the pointer instead of the value and convince yourself the whole program is haunted", minutesAgo: 126 },
  { id: 5, author: "yasmin_codes", body: "Anyone else getting a CORS error only on the deployed preview? works locally, of course", minutesAgo: 48 },
  { id: 6, author: "omar_said", body: "Check whether the OPTIONS request is reaching your auth middleware. That got me last week.", minutesAgo: 44, replyTo: 5 },
  { id: 7, author: "yasmin_codes", body: "oh wow it was. I was only checking the GET in the logs lol", minutesAgo: 41, replyTo: 6 },
  { id: 8, author: "lina_dev", body: "Had this with a preview URL too — make sure the exact origin is in the allowlist, not just localhost", minutesAgo: 38, replyTo: 5 },
  { id: 9, author: "yasmin_codes", body: "fixed it, thank you both 🙏", minutesAgo: 35, replyTo: 8 },
  { id: 10, author: "rami_pixel", body: "anyone around for one quick co-op round later? the word quick is doing a lot of work here", minutesAgo: 31 },
  { id: 11, author: "lina_dev", body: "I'm in after dinner. last time was absolutely not one round btw", minutesAgo: 28, replyTo: 10 },
  { id: 12, author: "rami_pixel", body: "we had to finish the level!!", minutesAgo: 26, replyTo: 11 },
  { id: 13, author: "omar_said", body: "send me the invite, I need a break from looking at query plans", minutesAgo: 24, replyTo: 10 },
  { id: 14, author: "lina_dev", body: "Tiny CSS win: finally got the empty state to line up properly on mobile. took longer than the actual feature", minutesAgo: 21 },
  { id: 15, author: "yasmin_codes", body: "the 1px fixes always take the whole afternoon somehow", minutesAgo: 18, replyTo: 14 },
  { id: 16, author: "lina_dev", body: "right?? and then someone opens it at 125% zoom and there goes my victory", minutesAgo: 15, replyTo: 15 },
];

const postMoments = [
  "Spent my lunch break tracking down a weird cache issue and it was one stale service worker",
  "The test only failed on CI because the machine clock was a few milliseconds ahead",
  "Finally replaced the giant config file with something I can read without scrolling forever",
  "I was debugging the API for an hour before noticing I had two local servers running",
  "Today’s bug was a typo in a variable name that looked completely normal at 2am",
  "Tried to make one small CSS change and somehow learned three new things about grid",
  "Got a clean deploy on the first try and now I’m suspicious of everything",
  "Spent the morning deleting code that I was very proud of last month",
  "The feature was done yesterday; today was all the little states nobody mentioned",
  "I keep forgetting that the mobile keyboard covers half the screen until I test it",
  "Found a TODO from me six months ago and, annoyingly, it was still right",
  "Finally got the local database and the test database to agree on the same thing",
  "The error message was accurate the whole time, I just didn't want it to be",
  "A tiny refactor made the tests easier to read, which feels like a better win than I expected",
  "Spent way too long looking at the wrong branch and then blamed the cache",
  "I like when a bug turns out to be boring. This one was a missing await",
  "Trying to keep this side project small but the settings page now has settings",
  "The designer and I both thought the other person had changed the spacing",
  "My first fix made it worse, but at least now I know where the problem is",
  "Had a nice quiet hour to work and got more done than in the whole morning",
  "The docs example used an older version and I thought I was losing it",
  "Forgot to restart the dev server after changing the environment variable. again",
  "I finally wrote down the setup steps instead of sending myself another message",
  "There's something satisfying about removing a dependency you stopped needing ages ago",
  "Today I learned that this browser treats that input type differently. noted",
  "I thought the request was slow but it was my laptop trying to update in the background",
  "A teammate spotted the issue in about thirty seconds after I stared at it all afternoon",
  "Moved one component and somehow made the whole page easier to understand",
  "The PR looked tiny until I opened the screenshot at mobile width",
  "I fixed the test by making the test data less weird. Should have started there",
  "My terminal history is now just variations of the same three commands",
  "Spent the evening making an old project run again, mostly for nostalgia",
  "The button worked fine until I tried using the keyboard. glad I checked",
  "I love a clean git status more than is probably normal",
  "Found out the API was fine and my mock response was from last week",
  "The first version is finally in front of someone who isn't me",
  "A good README saved me from explaining the same setup twice today",
  "I changed the name of a variable and the whole function suddenly made sense",
  "Had to undo my clever fix and use the obvious one. the obvious one works",
  "I have spent more time picking an icon than wiring up the actual feature",
  "Got a flaky test to pass three times in a row, not calling it fixed just yet",
  "One of those days where every tab is either docs or a question I already asked",
  "The design looked perfect in the mockup and then the real text arrived",
  "Finally added the empty state instead of pretending the list is never empty",
  "I was sure it was a database issue. It was a space at the end of the input",
  "Writing the migration took less time than deciding what to call the column",
  "Pushed a fix and immediately remembered the other place that uses the same helper",
  "Got stuck, went to make tea, came back and noticed the missing bracket",
  "I keep saying I’ll clean up these styles after launch. launch is apparently today",
  "Somehow the oldest bug in the tracker was also the easiest one to reproduce",
];

const postEndings = [
  "I really thought this would take five minutes.",
  "At least I know what to check next time.",
  "Anyway, taking a break before I touch it again.",
  "That one is going in the notes for future me.",
  "Not a glamorous fix, but it works.",
  "Closing the laptop while it's still behaving.",
  "The logs were basically telling me the answer.",
  "This is why I try to keep a scratch file around.",
  "It looked obvious right after I stopped staring at it.",
  "Now I can finally close the seventeen tabs I opened.",
  "The fix was smaller than the debugging session.",
  "At least nobody saw me blame the wrong service.",
  "That is enough screen time for one evening.",
  "I owe my future self a better test for this.",
  "No idea why I didn't check that first.",
  "Going to call that a win and get some food.",
  "I should probably write this down before I forget.",
  "The boring explanation was the right one again.",
  "Took a walk and came back with the answer. rude.",
  "That'll teach me to trust the first error message.",
  "Might leave the cleanup for tomorrow.",
  "The second cup of coffee did not help, but the breakpoint did.",
  "It was one tiny assumption hiding in the middle.",
  "A good reminder to test the actual thing people click.",
  "I am choosing to be pleased that it works now.",
  "The screenshot looked much worse than the code change.",
  "This is why I don't deploy right before dinner.",
  "I had the right idea and the wrong file open.",
  "It passed locally, which was apparently not the question.",
  "Could have saved myself a lot of scrolling there.",
  "The first fix was clever; the second one was correct.",
  "I should stop saying 'quick change' out loud.",
  "At least the reproduction steps are finally clear.",
  "A comment would've saved me from my own code.",
  "Taking a break before I invent a new problem.",
  "That bug has been living in my head rent-free all day.",
  "Funny how much easier this is with fresh eyes.",
  "Going to leave it alone while it's working.",
  "One less mystery in the project, I guess.",
  "This is going in the little list of things I learned today.",
  "Turns out reading the docs would've been faster.",
  "The fix is in; now I can go be a person again.",
  "Not my most elegant hour, but we got there.",
  "I can stop refreshing the page every ten seconds now.",
  "The test caught it before anyone else did, so fair enough.",
  "That was a very long route to a missing value.",
  "I will absolutely forget this by next week.",
  "No big breakthrough, just finally checked the right place.",
];

const generatedPostsPerMoment = Math.ceil(284 / postMoments.length);
const extraPosts: SeedPost[] = Array.from({ length: 284 }, (_, index) => {
  const moment = postMoments[Math.floor(index / generatedPostsPerMoment)];
  const ending = postEndings[index % postEndings.length];
  if (!moment || !ending) throw new Error(`Missing post text for generated post ${index + 17}`);

  return {
    id: index + 17,
    author: users[(index * 7 + 3) % users.length]!.handle,
    body: `${moment}. ${ending}`,
    minutesAgo: 180 + index * 47,
  };
});

posts.push(...extraPosts);

if (users.length !== 50 || posts.length !== 300) {
  throw new Error(`Seed data size mismatch: expected 50 users and 300 posts, got ${users.length} and ${posts.length}.`);
}

const likes: Record<number, string[]> = {
  1: ["amine_dev", "khalil_sec", "maya_builds", "yasmin_codes", "omar_said", "lina_dev", "rami_pixel"],
  2: ["sarah_ui", "khalil_sec", "maya_builds", "yasmin_codes", "omar_said", "rami_pixel"],
  3: ["amine_dev", "sarah_ui", "maya_builds", "omar_said", "lina_dev"],
  4: ["amine_dev", "sarah_ui", "khalil_sec", "rami_pixel"],
};

const reposts: Record<number, string[]> = {
  1: ["amine_dev", "maya_builds", "lina_dev"],
  2: ["sarah_ui", "omar_said"],
  3: ["khalil_sec"],
  4: ["sarah_ui"],
};

async function seed(): Promise<void> {
  if (!password || password.length < 12) {
    throw new Error("Set RELAY_SEED_PASSWORD to a password of at least 12 characters before seeding.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.$transaction(async (tx) => {
    const umx0x = await tx.user.findUnique({
      where: { handle: "umx0x" },
      select: { id: true },
    });
    if (!umx0x) {
      throw new Error("Cannot seed follows: the existing account @umx0x was not found.");
    }

    const userIds = new Map<string, string>();

    for (const user of users) {
      const saved = await tx.user.upsert({
        where: { handle: user.handle },
        create: { ...user, passwordHash },
        update: { ...user, passwordHash },
        select: { id: true },
      });
      userIds.set(user.handle, saved.id);
    }

    for (const post of posts) {
      const authorId = userIds.get(post.author);
      if (!authorId) throw new Error(`Missing seeded author: ${post.author}`);

      const replyToId = post.replyTo === undefined ? null : seedId(post.replyTo);
      await tx.post.upsert({
        where: { id: seedId(post.id) },
        create: {
          id: seedId(post.id),
          authorId,
          body: post.body,
          replyToId,
          createdAt: new Date(Date.now() - post.minutesAgo * 60_000),
        },
        update: { authorId, body: post.body, replyToId },
      });
    }

    const bulkInteractions = extraPosts.flatMap((post, index) => {
      const authorIndex = (index * 7 + 3) % users.length;
      const likesForPost = 2 + (index % 8);
      const postLikes = Array.from({ length: likesForPost }, (_, voterOffset) => ({
        userId: userIds.get(users[(authorIndex + voterOffset + 1) % users.length]!.handle)!,
        postId: seedId(post.id),
        type: InteractionType.LIKE,
      }));
      if (index % 3 !== 0) return postLikes;

      return [
        ...postLikes,
        {
          userId: userIds.get(users[(authorIndex + likesForPost + 1) % users.length]!.handle)!,
          postId: seedId(post.id),
          type: InteractionType.REPOST,
        },
      ];
    });

    const interactions = [
      ...Object.entries(likes).flatMap(([postNumber, handles]) =>
        handles.map((handle) => ({
          userId: userIds.get(handle)!,
          postId: seedId(Number(postNumber)),
          type: InteractionType.LIKE,
        })),
      ),
      ...Object.entries(reposts).flatMap(([postNumber, handles]) =>
        handles.map((handle) => ({
          userId: userIds.get(handle)!,
          postId: seedId(Number(postNumber)),
          type: InteractionType.REPOST,
        })),
      ),
      ...bulkInteractions,
    ];

    if (interactions.some((interaction) => !interaction.userId)) {
      throw new Error("An interaction references a user that was not seeded.");
    }

    await tx.interaction.createMany({ data: interactions, skipDuplicates: true });

    const followEdges = users.flatMap((follower) => {
      const followerId = userIds.get(follower.handle);
      if (!followerId) throw new Error(`Missing seeded follower: ${follower.handle}`);

      const seededFollows = users
        .filter((followed) => followed.handle !== follower.handle)
        .map((followed) => {
          const followedId = userIds.get(followed.handle);
          if (!followedId) throw new Error(`Missing seeded account: ${followed.handle}`);
          return { followerId, followedId };
        });

      return [...seededFollows, { followerId, followedId: umx0x.id }];
    });
    await tx.follow.createMany({ data: followEdges, skipDuplicates: true });

    for (const post of posts) {
      const replyCount = await tx.post.count({
        where: { replyToId: seedId(post.id), deletedAt: null },
      });
      await tx.post.update({
        where: { id: seedId(post.id) },
        data: { replyCount },
      });
    }
  });

  console.log(`Seeded ${users.length} accounts, ${posts.length} posts, and follow relationships with @umx0x.`);
}

seed()
  .catch((error: unknown) => {
    console.error("Relay database seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
