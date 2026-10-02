---
title: "Submit a Game"
layout: "sq-page"
sq_page: "submit-a-game"
# The Submit a Game form, field by field (same questions and order as the Squarespace form). It posts to
# params.forms.submit_game.
form:
  - { name: email, label: "Your email", type: email, required: true }
  - { name: news, type: checkbox-single, label: "Sign up for news and updates" }
  - { name: title, label: "What's the title of the game?", type: text, required: true }
  - { name: free, label: "Is the game free to play?", type: radio, required: true, options: ["Yes", "Yes, but it requires an online account", "No"] }
  - { name: browser, label: "Is the game playable in a browser", type: radio, required: true, options: ["Yes", "No"] }
  - { name: maker, label: "Who made the game?", type: text, required: true }
  - { name: url, label: "Please provide a link to the playable game here", type: text, required: true }
  - { type: section, label: "These next questions are optional, but your answers help us categorize and review your submission faster!" }
  - { name: grades, label: "What grade-range is this game suited for?", desc: "select all that apply", type: checkbox, options: ["Kindergarten - 3rd grade", "4th grade - 5th grade", "6th grade - 8th grade", "9th grade - 12th grade"] }
  - { name: video, label: "Is there a trailer or gameplay video of this game?", desc: "If yes, please link it below:", type: text }
  - { name: media, label: "Is there a folder with thumbnails, screenshots or logos?", desc: "Optimally you will provide a thumbnail (3x2), 4 screenshots of in-game play, a logo, and a hero image (landscape.) Please link it below:", type: text }
  - { name: curriculum, label: "Are there teacher support materials or curriculum associated with this game?", desc: "If yes, please link it below:", type: text }
  - { name: tagline, label: "Is there a short description or tagline for this game?", type: textarea }
  - { name: description, label: "What is the full description of this game?", desc: "Feel free to link to an external site or paste the text below", type: textarea }
  - { name: subjects, label: "What is the subject of the game", desc: "Select all that apply", type: checkbox, options: ["Art", "Business (marketing, personal finance)", "Ecology", "English Language Learning / English as a second Language", "Family & Consumer Science Education", "Health", "Information Technology", "Language Arts", "Math", "Science", "Social Studies", "Technology Education", "World Languages"] }
submit_label: "Submit"
---
