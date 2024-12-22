const _ = require('lodash');
const Telegraf = require('telegraf');
const sharp = require('sharp');
const captcha = require('svg-captcha');
const md5 = require('md5');
const dayjs = require('dayjs');
const Markup = require('telegraf/markup');
const genfun = require('generate-function');
const telegrafCommandParts = require('telegraf-command-parts');
const redis = require('./redis');
const querystring = require('querystring');

const { d } = genfun.formats;
const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = {};

const DELAYED_SECONDS_DOOR = 120;
const DELAYED_SECONDS_PLAY = 30;

// 作為鍊式連接的中間件，用於在下一個中間件之前等待指定的時間
const sleepWithResult = (delay, result) => new Promise(resolve => setTimeout(() => resolve(result), delay * 1000));

// delete message after 30 seconds
const handleDeleteMessage = (message, seconds = 30) => {
  const chatId = _.get(message, 'chat.id');
  const messageId = _.get(message, 'message_id');
  const key = `${chatId}:${messageId}`;

  if (cache[key]) {
    clearTimeout(cache[key]);
  }

  cache[key] = setTimeout(
    async (chatMessage) => {
      await bot.telegram.deleteMessage(chatMessage.chat.id, chatMessage.message_id);
    },
    seconds * 1000,
    message,
  );
};

const formula = ([numberA, operatorA, numberB, operatorB, numberC]) => {
  const gen = genfun();
  gen(`
  function () {
    return ${d(numberA)} ${operatorA} ${d(numberB)} ${operatorB} ${d(numberC)};
  }
`);

  return gen.toFunction();
};

const makeQuestions = amount => {
  Array(amount).fill().map(() => {
    const getRandomNumber = () => {
      const randomNumber = Array(5)
        .fill()
        .reduce((current, value, index) => {
          const operators = ['+', '-', '*'];

          if (index % 2 === 0) {
            current.push(_.random(0, 99));
          } else {
            current.push(operators[_.random(0, operators.length - 1)]);
          }

          return current;
        }, []);

      const total = formula(randomNumber)();

      if (calculateTotalCache.includes(total)) {
        return getRandomNumber();
      }

      calculateTotalCache.push(total);

      return {
        total,
        formula: randomNumber,
      };
    };

    const hash = md5(`${dayjs().valueOf()}${_.random(0, 100)}`);

    return {
      hash,
      randomNumber: getRandomNumber(),
    };
  });
}

bot
  .use(telegrafCommandParts())
  .on('new_chat_members', async (ctx) => {
    const newChatMember = _.get(ctx, 'message.new_chat_member');
    const newChatMemberId = _.get(newChatMember, 'id');
    const firstName = _.get(newChatMember, 'first_name', '');
    const lastName = _.get(newChatMember, 'last_name', '');
    const userId = _.get(ctx, 'from.id');
    const chatId = _.get(ctx, 'chat.id');
    const title = _.get(ctx, 'chat.title');

    const name = `${firstName} ${lastName}`.trim();

    if (userId === newChatMemberId) {
      await ctx.telegram.callApi(
        'restrictChatMember',
        {
          chat_id: chatId,
          user_id: newChatMemberId,
          permissions: {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
          },
        },
      );

      const calculateTotalCache = [];
      const questions = Array(3)
        .fill()
        .map(() => {
          const getRandomNumber = () => {
            const randomNumber = Array(5)
              .fill()
              .reduce((current, value, index) => {
                const operators = ['+', '-', '*'];

                if (index % 2 === 0) {
                  current.push(_.random(0, 99));
                } else {
                  current.push(operators[_.random(0, operators.length - 1)]);
                }

                return current;
              }, []);

            const total = formula(randomNumber)();

            if (calculateTotalCache.includes(total)) {
              return getRandomNumber();
            }

            calculateTotalCache.push(total);

            return {
              total,
              formula: randomNumber,
            };
          };

          const hash = md5(`${dayjs().valueOf()}${_.random(0, 100)}`);

          return {
            hash,
            randomNumber: getRandomNumber(),
          };
        });

      const answer = questions[_.random(0, questions.length - 1)];

      const messages = await redis.smembers(`app:tg-captcha:chat:${chatId}:user:${newChatMemberId}:messages`);

      await Promise.all(
        [
          redis.setex(`app:tg-captcha:chat:${chatId}:user:${newChatMemberId}`, DELAYED_SECONDS_DOOR, answer.hash),
          ...messages
            .map(
              (message) => ctx
                .deleteMessage(message)
                .catch(console.log),
            ),
        ],
      );

      const image = Buffer.from(captcha(answer.randomNumber.formula.join(' ')));
      const replyPhoto = await ctx.replyWithPhoto(
        {
          source: await sharp(image)
            .flatten({ background: '#ffffff' })
            .resize( 800, 100, {fit: sharp.fit.fill })
            .toFormat('jpg')
            .toBuffer(),
        },
        {
          reply_markup: {
            inline_keyboard: [
              [
                Markup.urlButton('捐款', 'http://bit.ly/31POewi'),
                ...questions.map(
                  (question) => {
                    const button = Markup.callbackButton(question.randomNumber.total, `question|${question.hash}`);

                    return button;
                  },
                )
              ],
              [
                Markup.urlButton('💗 捐款給牧羊犬(非看門驢) 💗', 'http://bit.ly/31POewi'),
              ],
              [
                Markup.callbackButton('💢 這個是spam 💢', `kick|${userId}`),
              ],
            ],
          },

          caption: `👏 歡迎新使用者${name}加入${title}，請在${DELAYED_SECONDS_DOOR}秒內回答圖片的問題，否則看門驢會把你吃了喔`,
          reply_to_message_id: ctx.message.message_id,
        },
      );

      await redis.setex(`app:tg-captcha:chat:${chatId}:message:${replyPhoto.message_id}`, DELAYED_SECONDS_DOOR, userId);

      setTimeout(
        async (context) => {
          const requestUserId = _.get(context, 'message.new_chat_member.id');
          const requestChatId = _.get(context, 'chat.id');
          const hash = await redis.get(`app:tg-captcha:chat:${requestChatId}:user:${requestUserId}`);

          if (hash) {
            await Promise.all(
              [
                context.kickChatMember(requestUserId).catch(console.log),
                context.reply(`❌ 因為超過${DELAYED_SECONDS_DOOR}秒回答，所以看門驢把你吃掉了`),
                redis.del(`app:tg-captcha:chat:${requestChatId}:user:${requestUserId}`),
              ],
            );
          }
        },
        DELAYED_SECONDS_DOOR * 1000,
        ctx,
      );
    }
  })
  .action(/question\|.+/, async (ctx) => {
    const userId = _.get(ctx, 'from.id');
    const chatId = _.get(ctx, 'chat.id');
    const callback = _.get(ctx, 'update.callback_query.message');
    const messageId = _.get(callback, 'message_id');
    const inlineButton = _.get(ctx, 'match.0', '');
    const [, inlineAnswer] = inlineButton.split('|');
    const storedChallengeId = await redis.get(`app:tg-captcha:chat:${chatId}:message:${messageId}`);
    const replyMessage = _.get(callback, 'reply_to_message');
    const challengeId = _.get(replyMessage, 'new_chat_member.id', _.toNumber(storedChallengeId));
    const challengeKey = `app:tg-captcha:chat:${ctx.chat.id}:user:${userId}`;
    const answerKey = `app:tg-captcha:chat:${chatId}:user:${userId}`;
    const captchaAnswer = await redis.get(challengeKey);

    if (userId !== challengeId) {
      await ctx.answerCbQuery('這不是你的按鈕，請不要亂點 😠');
    } else if (captchaAnswer === inlineAnswer) {
      await Promise.all(
        [
          redis.del(challengeKey),
          redis.del(answerKey),
          ctx.deleteMessage(messageId).catch(console.log),
          ctx.reply(
            '⭕️ 恭喜回答正確，看門驢歡迎你的加入~',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    Markup.callbackButton('💢 這個是spam 💢', `kick|${userId}}`),
                  ],
                ],
              },
              // reply_to_message_id: ctx.reply_to_message.message_id,
            },
          ).then(result => handleDeleteMessage(result,5)),
          ctx.telegram.callApi(
            'restrictChatMember',
            {
              chat_id: chatId,
              user_id: userId,
              permissions: {
                can_send_messages: true,
                can_send_media_messages: true,
                can_send_polls: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
                can_change_info: true,
                can_invite_users: true,
                can_pin_messages: true,
              },
            },
          ),
        ],
      );
    } else {
      await Promise.all(
        [
          redis.del(challengeKey),
          redis.del(answerKey),
          ctx.deleteMessage(messageId).catch(console.log),
          ctx.reply(
            '❌ 回答失敗，所以看門驢把你吃掉了',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    Markup.callbackButton('🥺 不小心誤殺了 🥺', `unban|${userId}`),
                  ],
                ],
              },
              // reply_to_message_id: ctx.reply_to_message.message_id,
            },
          ).then(handleDeleteMessage),
          ctx.kickChatMember(userId),
        ],
      );
    }
  })
  .action(/quiz\|.+/, async (ctx) => {
    const userId = _.get(ctx, 'from.id');
    const chatId = _.get(ctx, 'chat.id');
    const callback = _.get(ctx, 'update.callback_query.message');
    const messageId = _.get(callback, 'message_id');
    const inlineButton = _.get(ctx, 'match.0', '');
    const [, inlineAnswer] = inlineButton.split('|');
    const storedChallengeId = await redis.get(`app:tg-captcha:chat:${chatId}:message:${messageId}`);
    const replyMessage = _.get(callback, 'reply_to_message');
    const challengeId = _.get(replyMessage, 'new_chat_member.id', _.toNumber(storedChallengeId));
    const challengeKey = `app:tg-captcha:chat:${ctx.chat.id}:user:${userId}`;
    const answerKey = `app:tg-captcha:chat:${chatId}:user:${userId}`;
    const captchaAnswer = await redis.get(challengeKey);

    if (userId !== challengeId) {
      await ctx.answerCbQuery('這不是你的按鈕，你這麼想做題嗎? 😠');
    } else if (captchaAnswer === inlineAnswer) {
      await Promise.all(
        [
          redis.del(challengeKey),
          redis.del(answerKey),
          // ctx.deleteMessage(messageId).catch(console.log),
          ctx.reply('⭕️ 恭喜回答正確，看門驢覺得你很聰明~')
            .then(handleDeleteMessage),
        ],
      );
    } else {
      await Promise.all(
        [
          redis.del(challengeKey),
          redis.del(answerKey),
          // ctx.deleteMessage(messageId).catch(console.log),
          ctx.reply('❌ 回答失敗，所以看門驢把你吃掉了，但消化不良又拉出來了',)
            .then(handleDeleteMessage),
        ],
      );
    }
  })
  .command('admin', async (ctx) => {
    const group = _.get(ctx, 'state.command.splitArgs.0', ctx.chat.id);
    const admins = await ctx.telegram.getChatAdministrators(group);

    const groupAdmins = admins
      .filter((admin) => !admin.user.is_bot)
      .map((admin) => {
        if (admin.user.username) {
          return `@${admin.user.username}`;
        }

        return `<a href="tg://user?id=${admin.user.id}"${querystring.escape(admin.user.first_name)} ${querystring.escape(admin.user.last_name)}</a>`;
      });

    await ctx.replyWithHTML(groupAdmins.join('\n'));
  })
  .command('about', async (ctx) => {
    await ctx.reply(`看門驢是一個源自於牧羊犬的免費的防spam的bot，本身沒有任何贊助以及金援，全部的成本都是由開發者自行吸收。
如果你希望看門驢能走的更久，可以的話請多多支持我能再把機器開下去，感謝 🙏
歡迎樂捐，所有捐款人會在這裡留下您的名字
贊助名單:
`);
  })
  .on('message', async (ctx, next) => {
    const userId = _.get(ctx, 'message.from.id');
    const text = _.get(ctx, 'message.text');
    const messageId = _.get(ctx, 'message.message_id');
    const chatId = _.get(ctx, 'chat.id');

    if (text) {
      const key = `app:tg-captcha:chat:${chatId}:user:${userId}:messages`;

      await redis
        .pipeline()
        .sadd(key, messageId)
        .expire(key, 60)
        .exec();
    }

    await next();
  })
  .command('play', async (ctx) => {
    const newChatMember = _.get(ctx, 'message.from');
    const newChatMemberId = _.get(newChatMember, 'id');
    const firstName = _.get(newChatMember, 'first_name', '');
    const lastName = _.get(newChatMember, 'last_name', '');
    const userId = _.get(ctx, 'from.id');
    const chatId = _.get(ctx, 'chat.id');
    const title = _.get(ctx, 'chat.title') || '1對1對話';

    const name = `${firstName} ${lastName}`.trim();
    console.log({cmd: 'play', new: newChatMemberId, user:`${userId}(${name})`, chat: `${chatId}(${title})`})

    const questions = makeQuestions(3);

    const answer = questions[_.random(0, questions.length - 1)];
    const messages = await redis.smembers(`app:tg-captcha:chat:${chatId}:user:${newChatMemberId}:messages`);

    await Promise.all(
      [
        redis.setex(`app:tg-captcha:chat:${chatId}:user:${newChatMemberId}`, DELAYED_SECONDS_PLAY, answer.hash),
        // ...messages
        //   .map(
        //     (message) => ctx
        //       .deleteMessage(message)
        //       .catch(console.log),
        //   ),
      ],
    );

    const image = Buffer.from(captcha(answer.randomNumber.formula.join(' ')));
    const image_buffer = await sharp(image)
      .flatten({ background: '#ffffff' })
      .resize( 600, 150, {fit: sharp.fit.fill })
      .toFormat('jpg')
      .toBuffer()
    ;
    const inline_keyboard = [
      [
        Markup.callbackButton('封鎖我', `quiz|0`),
        ...questions.map(
          (question) => {
            const button = Markup.callbackButton(question.randomNumber.total, `quiz|${question.hash}`);
            return button;
          },
        ),
        Markup.callbackButton('封我吧', `quiz|1`),
      ],
      [
        Markup.urlButton('💗 捐款給牧羊犬(非看門驢) 💗', 'http://bit.ly/31POewi'),
      ],
    ];
    const replyPhoto = await ctx.replyWithPhoto(
      {
        source: image_buffer
      },
      {
        reply_markup: { inline_keyboard },
        caption: `👏 歡迎${name}來${title}與驢子玩猜謎，請在${DELAYED_SECONDS_PLAY}秒內回答圖片的問題，否則看門驢會把你吃了喔!`,
        reply_to_message_id: ctx.message.message_id,
      },
    );

    await redis.setex(`app:tg-captcha:chat:${chatId}:message:${replyPhoto.message_id}`, DELAYED_SECONDS_PLAY, userId);
    setTimeout(
      async (context) => {
        const requestUserId = _.get(context, 'message.from.id');
        const requestChatId = _.get(context, 'chat.id');
        const hash = await redis.get(`app:tg-captcha:chat:${requestChatId}:user:${requestUserId}`);
        console.log({command: 'play4', requestUserId, requestChatId, hash})
        if (hash) {
          await Promise.all(
            [
              // context.kickChatMember(requestUserId).catch(console.log),
              context.reply(`❌ 因為超過${DELAYED_SECONDS_PLAY}秒回答，所以看門驢把你吃掉了，但消化不良又拉出來了.`)
                .then(handleDeleteMessage),
              redis.del(`app:tg-captcha:chat:${requestChatId}:user:${requestUserId}`),
            ],
          );
        }
      },
      DELAYED_SECONDS_PLAY * 1000,
      ctx,
    );
  })
  .on('message', async (ctx, next) => {
    const chat = await ctx.getChat();
    if(chat.type === 'private') {
      return await ctx.reply('請在群組裡使用我喔~');
    }
    const admins = await ctx.getChatAdministrators();
    const adminId = _.map(admins, 'user.id');

    if (adminId.includes(ctx.from.id)) {
      await next();
    }
  })
  .command('ban', async (ctx) => {
    const muteMinutes = _.get(ctx, 'state.command.splitArgs.0', 0);
    const userId = _.get(ctx, 'message.reply_to_message.from.id');
    const minutes = _.toInteger(muteMinutes);

    if (userId) {
      const firstName = _.get(ctx, 'message.reply_to_message.from.first_name', '');
      const lastName = _.get(ctx, 'message.reply_to_message.from.last_name', '');

      await Promise.all(
        [
          ctx.kickChatMember(userId, Math.round(dayjs().add(minutes, 'minute').valueOf() / 1000)),
          ctx.reply(
            `已經將${firstName} ${lastName}${minutes === 0 ? '封鎖' : `封鎖${minutes}分鐘`}`,
            {
              reply_to_message_id: ctx.message.reply_to_message.message_id,
            },
          ),
        ],
      );
    } else {
      await ctx.reply(
        '請利用回覆的方式指定要封鎖的人',
        {
          reply_to_message_id: ctx.message.reply_to_message.message_id,
        },
      );
    }
  })
  .command('mute', async (ctx) => {
    const muteMinutes = _.get(ctx, 'state.command.splitArgs.0', 5);
    const userId = _.get(ctx, 'message.reply_to_message.from.id');
    const minutes = _.toInteger(muteMinutes);

    if (userId) {
      const firstName = _.get(ctx, 'message.reply_to_message.from.first_name', '');
      const lastName = _.get(ctx, 'message.reply_to_message.from.last_name', '');

      await Promise.all(
        [
          ctx.telegram.callApi(
            'restrictChatMember',
            {
              chat_id: ctx.chat.id,
              user_id: userId,
              permissions: {
                can_send_messages: false,
                can_send_media_messages: false,
                can_send_polls: false,
                can_send_other_messages: false,
                can_add_web_page_previews: false,
                can_change_info: false,
                can_invite_users: false,
                can_pin_messages: false,
              },
              until_date: Math.round(dayjs().add(minutes, 'minute').valueOf() / 1000),
            },
          ),
          ctx.reply(
            `已經將${firstName} ${lastName}${minutes === 0 ? '禁言' : `禁言${minutes}分鐘`}`,
            {
              reply_to_message_id: ctx.message.reply_to_message.message_id,
            },
          ),
        ],
      );
    } else {
      await ctx.reply(
        '請利用回覆的方式指定要禁言的人',
        {
          reply_to_message_id: ctx.message.reply_to_message.message_id,
        },
      );
    }
  })
  .action(/unban\|.+/, async (ctx) => {
    const inlineButton = _.get(ctx, 'match.0', '');
    const [, userId] = inlineButton.split('|');

    await Promise.all(
      [
        ctx.editMessageText('看門驢已經解除他的封鎖了喔 🐶').then(handleDeleteMessage),
        ctx.unbanChatMember(userId),
      ],
    );
  })
  .action(/kick\|.+/, async (ctx) => {
    const inlineButton = _.get(ctx, 'match.0', '');
    const [, userId] = inlineButton.split('|');
    // console.log(ctx.update);
    await Promise.all(
      [
        // ctx.
        ctx.answerCbQuery('看門驢已經把他趕走了哦 🐶'),
        ctx.kickChatMember(userId),
        ctx.editMessageCaption('看門驢已經把他趕走了哦 🐶').then(handleDeleteMessage),
      ],
    );
  })
  .catch(console.log)
  .launch();
