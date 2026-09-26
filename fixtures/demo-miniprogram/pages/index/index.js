Page({
  data: {
    message: "Hello, wechat-devtools-mcp!",
    tapCount: 0,
  },
  onLoad() {
    console.log("demo page loaded");
  },
  onTap() {
    console.log("button tapped, count =", this.data.tapCount + 1);
    this.setData({ tapCount: this.data.tapCount + 1 });
  },
});
