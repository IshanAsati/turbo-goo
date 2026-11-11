export const SAMPLE_TITLE = "Sample: Introduction to Derivatives";

/** A realistic, slightly messy lecture transcript so first-time users see denoising + math in action. */
export const SAMPLE_SOURCE = `Okay everyone, settle down, let's get started. Quick reminder that the midterm is on Thursday and it will cover derivatives, so pay attention today. Also the cafeteria is apparently out of coffee, which I know is a tragedy for some of you.

Alright. Today we're talking about derivatives. A derivative is the instantaneous rate of change of a function at a point. Geometrically, the derivative at a point is the slope of the tangent line to the graph at that point.

Formally, the derivative of f at x is defined as the limit of f(x+h) minus f(x), all divided by h, as h approaches zero. We write this as f prime of x. This limit definition is the foundation for everything else, so make sure you can write it from memory. The limit definition of the derivative is f'(x) = lim as h→0 of [f(x+h) − f(x)]/h.

Let's do an example. Take f(x) = x squared. Then f(x+h) minus f(x) is 2xh plus h squared. Divide by h and you get 2x plus h. As h goes to zero, that's just 2x. So the derivative of x squared is 2x. This one will be on the exam.

Next, the power rule. The power rule states that the derivative of x to the n is n times x to the n minus one. So the derivative of x cubed is 3x squared. The power rule works for any real number n, not just positive integers.

The constant multiple rule says that the derivative of c times f of x is c times the derivative of f. The sum rule says that the derivative of a sum is the sum of the derivatives. Together these mean differentiation is a linear operation.

The product rule is where students make mistakes. The product rule states that the derivative of f times g is f prime times g plus f times g prime. It is not simply the product of the derivatives! Remember that. The quotient rule states that the derivative of f over g is g times f prime minus f times g prime, all divided by g squared.

Now, the chain rule. The chain rule is used to differentiate composite functions. If y equals f of g of x, then the derivative is f prime of g of x times g prime of x. Think of it as the derivative of the outside function, evaluated at the inside, times the derivative of the inside. For example, the derivative of sine of x squared is cosine of x squared times 2x.

Some common derivatives you should memorize: the derivative of sine is cosine, the derivative of cosine is negative sine, and the derivative of e to the x is e to the x. The derivative of the natural log of x is one over x.

Why does any of this matter? Derivatives let us find maximum and minimum values. A critical point is a point where the derivative equals zero or is undefined. At a local maximum or minimum, the tangent line is horizontal, so the derivative is zero. This is the basis of optimization, which we'll use in physics, economics, and machine learning.

Is the derivative of a continuous function always defined? [?] Hmm, no. The absolute value function is continuous at zero but has a sharp corner there, so it is not differentiable at zero. Differentiability implies continuity, but continuity does not imply differentiability.

Okay, that's all for today. Don't forget homework one is due Monday. Any questions? No? Great, see you Thursday.`;
