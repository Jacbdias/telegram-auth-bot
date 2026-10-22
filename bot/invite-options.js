// Monta as opções de createChatInviteLink para um canal.
//
// O Telegram rejeita member_limit em links que exigem aprovação de admin
// ("member limit can't be specified for links requiring administrator approval"),
// então os dois são mutuamente exclusivos: canal com creates_join_request
// recebe link com aprovação e sem limite; os demais recebem link de uso limitado.
function buildInviteOptions(channel, { expireAt, memberLimit }) {
  const options = {
    expire_date: Math.floor(expireAt.getTime() / 1000)
  };

  if (channel && channel.creates_join_request) {
    options.creates_join_request = true;
  } else {
    options.member_limit = memberLimit;
  }

  return options;
}

module.exports = { buildInviteOptions };
