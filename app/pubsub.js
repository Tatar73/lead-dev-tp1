
// Imports the Google Cloud client library
const {PubSub} = require('@google-cloud/pubsub');
const dotenv = require('dotenv');
const { getAuthClient } = require('./auth');

dotenv.config();

async function sendMessage(
  messageData,
  projectId = process.env.PROJECT_ID,
  topicNameOrId = process.env.TOPIC_NAME,
  subscriptionName = process.env.SUBSCRIPTION_NAME
) {
  // Get authenticated client
  const authClient = getAuthClient();
  
  // Instantiates a client with explicit authentication
  const pubsub = new PubSub({
    projectId,
    authClient
  });

  // Get or create the topic
  let topic = pubsub.topic(topicNameOrId);
  const [topicExists] = await topic.exists();
  
  if (!topicExists) {
    [topic] = await pubsub.createTopic(topicNameOrId);
    console.log(`Topic ${topic.name} created.`);
  } else {
    console.log(`Using existing topic: ${topicNameOrId}`);
  }

  // Get or create the subscription
  let subscription = topic.subscription(subscriptionName);
  const [subscriptionExists] = await subscription.exists();
  
  if (!subscriptionExists) {
    [subscription] = await topic.createSubscription(subscriptionName);
    console.log(`Subscription ${subscriptionName} created.`);
  } else {
    console.log(`Using existing subscription: ${subscriptionName}`);
  }

  // Convert message data to JSON string and then to Buffer
  const dataBuffer = Buffer.from(JSON.stringify(messageData));
  
  // Send a message to the topic
  const messageId = await topic.publishMessage({data: dataBuffer});
  console.log(`📤 Message ${messageId} published successfully`);
  
  return messageId;
}


module.exports = {
  sendMessage
};
